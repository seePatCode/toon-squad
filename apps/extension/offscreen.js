// Offscreen document — owns the persistent WebSocket connection.
// Gets the bridge token from the background script by polling via sendMessage.
// Forwards browser_command messages to the service worker and relays results back.

// CHANGE THESE to your deployed bridge server URLs.
// After deploying apps/bridge to Fly.io (or another host), paste the URLs here.
const BRIDGE_URL = "wss://your-bridge.fly.dev/extension";
const HEALTH_URL = "https://your-bridge.fly.dev/health";
const RECONNECT_DELAY_MS = 2000;
const PING_INTERVAL_MS = 20000;
const TOKEN_POLL_MS = 3000;

let ws = null;
let pingTimer = null;
let currentToken = null;

// --- Token Polling ---
// Offscreen documents can only use chrome.runtime API.
// We poll the background script for the token via sendMessage/sendResponse.

async function pollForToken() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "get_token" });

    if (response?.token && response.token !== currentToken) {
      currentToken = response.token;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        connect();
      }
    }
  } catch {
    // Background script not ready yet
  }
}

// Poll immediately and every few seconds until connected
pollForToken();
setInterval(() => {
  pollForToken();
}, TOKEN_POLL_MS);

// --- Also listen for push notifications from background ---

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "set_token" && message.token !== currentToken) {
    currentToken = message.token;
    if (currentToken && (!ws || ws.readyState !== WebSocket.OPEN)) {
      connect();
    }
  }
});

// --- WebSocket Connection ---

async function connect() {
  if (!currentToken) return;

  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  ws = null;

  // Probe health first
  try {
    const res = await fetch(HEALTH_URL);
    if (!res.ok) throw new Error("not ready");
  } catch {
    setTimeout(connect, RECONNECT_DELAY_MS);
    return;
  }

  const wsUrl = `${BRIDGE_URL}?token=${encodeURIComponent(currentToken)}`;
  const socket = new WebSocket(wsUrl);

  socket.onopen = () => {
    ws = socket;
    console.log("[offscreen] Connected to bridge");

    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "keepalive" }));
      }
    }, PING_INTERVAL_MS);
  };

  socket.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    if (msg.type === "browser_command") {
      try {
        const result = await chrome.runtime.sendMessage({
          type: "execute_browser_command",
          action: msg.action,
          params: msg.params,
          id: msg.id,
        });
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "browser_result",
            id: msg.id,
            result: result,
          }));
        }
      } catch (err) {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "browser_result",
            id: msg.id,
            result: { error: String(err) },
          }));
        }
      }
    }
  };

  socket.onclose = () => {
    ws = null;
    clearInterval(pingTimer);
    console.log("[offscreen] Disconnected from bridge");
    if (currentToken) {
      setTimeout(connect, RECONNECT_DELAY_MS);
    }
  };

  socket.onerror = (err) => {
    console.error("[offscreen] WebSocket error:", err);
  };
}
