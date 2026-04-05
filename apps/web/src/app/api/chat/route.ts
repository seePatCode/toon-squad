import {
  convertToModelMessages,
  streamText,
  stepCountIs,
  type UIMessage,
} from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { cookies } from "next/headers";

export const maxDuration = 60;

const BRIDGE_URL = process.env.BRIDGE_URL ?? "http://localhost:3333";
const BRIDGE_SECRET = process.env.BRIDGE_SECRET ?? "";

// --- Browser Tools ---

async function executeBrowserCommand(
  action: string,
  params: Record<string, unknown>,
  userId: string,
): Promise<unknown> {
  const res = await fetch(`${BRIDGE_URL}/execute`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${BRIDGE_SECRET}`,
    },
    body: JSON.stringify({ action, params, userId }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Bridge error");
  return data.result;
}

function createBrowserTools(userId: string) {
  return {
    navigate: {
      description:
        "Navigate to a URL in the browser. Opens a new tab or navigates an existing one.",
      inputSchema: z.object({
        url: z.string().describe("The URL to navigate to"),
        tabId: z
          .number()
          .optional()
          .describe("Tab ID to navigate. Creates new tab if omitted."),
      }),
      execute: async (params: { url: string; tabId?: number }) =>
        executeBrowserCommand("navigate", params, userId),
    },
    get_page_content: {
      description: "Get the text content, title, and URL of a browser tab.",
      inputSchema: z.object({
        tabId: z.number().describe("The tab ID to read content from"),
      }),
      execute: async (params: { tabId: number }) =>
        executeBrowserCommand("get_page_content", params, userId),
    },
    screenshot: {
      description:
        "Take a screenshot of the currently visible tab. Returns a confirmation that the screenshot was taken. Use get_page_content to read the actual page text.",
      inputSchema: z.object({
        tabId: z.number().describe("The tab ID to screenshot"),
      }),
      execute: async (params: { tabId: number }) => {
        await executeBrowserCommand("screenshot", params, userId);
        return {
          captured: true,
          note: "Screenshot taken. Use get_page_content to read the page text.",
        };
      },
    },
    click: {
      description: "Click an element on the page by CSS selector.",
      inputSchema: z.object({
        tabId: z.number().describe("The tab ID"),
        selector: z
          .string()
          .describe("CSS selector of the element to click"),
      }),
      execute: async (params: { tabId: number; selector: string }) =>
        executeBrowserCommand("click", params, userId),
    },
    type_text: {
      description: "Type text into an input element by CSS selector.",
      inputSchema: z.object({
        tabId: z.number().describe("The tab ID"),
        selector: z
          .string()
          .describe("CSS selector of the input element"),
        text: z.string().describe("Text to type"),
      }),
      execute: async (params: {
        tabId: number;
        selector: string;
        text: string;
      }) => executeBrowserCommand("type_text", params, userId),
    },
    list_tabs: {
      description:
        "List all open browser tabs with their IDs, URLs, and titles.",
      inputSchema: z.object({}),
      execute: async () => executeBrowserCommand("list_tabs", {}, userId),
    },
    get_active_tab: {
      description: "Get info about the currently active browser tab.",
      inputSchema: z.object({}),
      execute: async () =>
        executeBrowserCommand("get_active_tab", {}, userId),
    },
  };
}

// --- System Prompt ---

const SYSTEM_PROMPT = `You are Toon Squad, an AI assistant that can control the user's Chrome browser.

You can navigate to websites, read page content, click elements, type text, and manage tabs — all through the user's actual browser with their logged-in sessions.

Use the browser tools when asked to look something up, fill out a form, or interact with any website.

Browser tool tips:
- Use get_page_content (not screenshot) to read what's on a page — it returns the text directly.
- Use list_tabs first to see what's open, then get_page_content on a specific tab.
- You cannot interact with the Toon Squad chat tab itself.
- When navigating, wait for the page to load before reading content.`;

// --- Rate Limiting ---
// NOTE: In-process only. On Vercel each isolate gets its own map,
// so this won't enforce limits across concurrent function instances.
// Replace with KV/Redis for real production rate limiting.

const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 20; // max requests per window

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(userId);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(userId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return false;
  }

  entry.count++;
  return true;
}

// --- Route Handler ---

export async function POST(req: Request) {
  const cookieStore = await cookies();
  const userId = cookieStore.get("toon-squad-uid")?.value;
  if (!userId) {
    return Response.json({ error: "No user session" }, { status: 401 });
  }

  if (!checkRateLimit(userId)) {
    return Response.json(
      { error: "Rate limit exceeded. Try again in a minute." },
      { status: 429 },
    );
  }

  const { messages } = (await req.json()) as {
    messages: UIMessage[];
  };

  const result = streamText({
    model: anthropic("claude-sonnet-4-6"),
    system: SYSTEM_PROMPT,
    messages: await convertToModelMessages(messages),
    tools: createBrowserTools(userId),
    stopWhen: stepCountIs(15),
    providerOptions: {
      anthropic: { thinking: { type: "enabled", budgetTokens: 5000 } },
    },
  });

  return result.toUIMessageStreamResponse();
}
