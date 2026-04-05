// Service Worker — handles Chrome API calls and user session management.
// The offscreen document owns the WebSocket connection and
// forwards browser commands here via chrome.runtime.sendMessage.

// --- Configuration ---
// CHANGE THIS to your deployed web app URL (no trailing slash).
// After deploying apps/web to Vercel, paste the production URL here.

const WEB_APP_ORIGIN = "https://your-app.vercel.app";

let currentToken = null;

// --- Offscreen Document Lifecycle ---

const OFFSCREEN_URL = "offscreen.html";
let creatingOffscreen = null;

async function ensureOffscreen() {
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });

  if (contexts.length > 0) return;

  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["WORKERS"],
    justification: "Maintains persistent WebSocket connection to Toon Squad bridge",
  });

  try {
    await creatingOffscreen;
  } catch {
    // Already exists — safe to ignore
  } finally {
    creatingOffscreen = null;
  }
}

// --- Token Management ---

async function refreshToken() {
  try {
    const cookie = await chrome.cookies.get({
      url: WEB_APP_ORIGIN,
      name: "toon-squad-uid",
    });

    if (!cookie?.value) {
      currentToken = null;
      return;
    }

    const res = await fetch(`${WEB_APP_ORIGIN}/api/auth/session-info`, {
      headers: { "X-User-Id": cookie.value },
    });
    const data = await res.json();

    if (data.authenticated && data.token) {
      currentToken = data.token;
    } else {
      currentToken = null;
    }
  } catch (err) {
    console.error("[bg] Token refresh failed:", err);
  }
}

// --- Startup: ensure offscreen is ready, then fetch token ---

async function startup() {
  await ensureOffscreen();
  // Small delay to let the offscreen document's scripts load
  await new Promise((r) => setTimeout(r, 500));
  await refreshToken();
  console.log("[bg] Startup complete");
}

startup();
chrome.runtime.onInstalled.addListener(() => startup());
chrome.runtime.onStartup.addListener(() => startup());

// Periodic refresh via chrome.alarms (survives service worker suspension)
chrome.alarms.create("periodic-check", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "periodic-check") {
    ensureOffscreen();
    refreshToken();
  }
});

// --- Browser Command Handlers ---

const handlers = {
  async navigate({ url, tabId }) {
    const tab = tabId
      ? await chrome.tabs.update(tabId, { url })
      : await chrome.tabs.create({ url });
    await waitForTabLoad(tab.id);
    return { tabId: tab.id, url: tab.url, title: tab.title };
  },

  async get_page_content({ tabId }) {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        title: document.title,
        url: document.location.href,
        text: document.body.innerText.slice(0, 50000),
      }),
    });
    return results[0]?.result ?? { error: "No result" };
  },

  async screenshot() {
    const dataUrl = await chrome.tabs.captureVisibleTab(null, {
      format: "png",
    });
    return { dataUrl };
  },

  async click({ tabId, selector }) {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel) => {
        const el = document.querySelector(sel);
        if (!el) return { error: `Element not found: ${sel}` };
        el.click();
        return { clicked: sel };
      },
      args: [selector],
    });
    return results[0]?.result ?? { error: "No result" };
  },

  async type_text({ tabId, selector, text }) {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel, txt) => {
        const el = document.querySelector(sel);
        if (!el) return { error: `Element not found: ${sel}` };
        el.focus();
        el.value = txt;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { typed: txt, selector: sel };
      },
      args: [selector, text],
    });
    return results[0]?.result ?? { error: "No result" };
  },

  async list_tabs() {
    const tabs = await chrome.tabs.query({});
    return tabs.map((t) => ({
      id: t.id,
      url: t.url,
      title: t.title,
      active: t.active,
    }));
  },

  async get_active_tab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return { error: "No active tab" };
    return { id: tab.id, url: tab.url, title: tab.title };
  },
};

// --- Message Handler ---

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Offscreen requesting current token
  if (message.type === "get_token") {
    sendResponse({ token: currentToken });
    return false;
  }

  if (message.type !== "execute_browser_command") return false;

  const handler = handlers[message.action];
  if (!handler) {
    sendResponse({ error: `Unknown action: ${message.action}` });
    return false;
  }

  handler(message.params ?? {})
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ error: String(err) }));

  return true;
});

// --- Helpers ---

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const listener = (id, changeInfo) => {
      if (id === tabId && changeInfo.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 15000);
  });
}
