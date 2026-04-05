# Toon Squad

A demo app showing how to give an AI agent control of a user's Chrome browser. The user chats with Claude through a web UI, and Claude can navigate sites, read pages, click elements, fill forms, and take screenshots -- all using the user's actual logged-in browser sessions.

This is a reference implementation, not a production service. It demonstrates the full architecture needed to bridge a cloud-hosted LLM to a local browser: how to relay commands through a WebSocket bridge, how to build a Chrome MV3 extension that survives service worker suspension, and how to authenticate every hop in the chain.

## Try the demo

A hosted version is running at **[toon-squad.vercel.app](https://toon-squad.vercel.app)**. To try it:

1. Clone this repo: `git clone https://github.com/seePatCode/toon-squad.git`
2. Update the extension URLs for the demo:
   - `apps/extension/background.js` — set `WEB_APP_ORIGIN` to `https://toon-squad.vercel.app`
   - `apps/extension/offscreen.js` — set `BRIDGE_URL` to `wss://toon-squad-bridge.fly.dev/extension` and `HEALTH_URL` to `https://toon-squad-bridge.fly.dev/health`
3. Open `chrome://extensions` in Chrome
4. Enable **Developer mode** (toggle in the top right)
5. Click **Load unpacked** and select the `apps/extension` directory
6. Visit [toon-squad.vercel.app](https://toon-squad.vercel.app) — the header badge should turn green ("Extension")
7. Try asking: "List all my open tabs" or "Navigate to Wikipedia"

No API keys or server setup needed to try the demo — just the extension.

## Architecture

![Architecture](docs/architecture.svg)

Three components work together:

| Component | What it does | Why it exists |
|-----------|-------------|---------------|
| **Web App** (`apps/web`) | Next.js chat UI + API routes. Streams responses from Claude, executes browser tools by calling the bridge. Deployed on Vercel. | Hosts the user-facing chat and the AI tool loop. Vercel is ideal for the stateless request/response pattern. |
| **Bridge** (`apps/bridge`) | Bun WebSocket relay between the web app (HTTP) and Chrome extension (WebSocket). Deployed on Fly.io. | Vercel Functions can't hold persistent WebSocket connections. The bridge maintains a long-lived WebSocket to each extension and exposes an HTTP API that the web app calls to execute browser commands. |
| **Extension** (`apps/extension`) | Chrome MV3 extension with a service worker and offscreen document. | Only a Chrome extension has access to `chrome.tabs`, `chrome.scripting`, and the user's cookies/sessions. The offscreen document holds the persistent WebSocket because MV3 service workers are suspended after 30 seconds of inactivity. |

### How it works

1. **User sends a message** in the chat UI
2. **API route streams a response** from Claude (Sonnet 4.6) using the AI SDK
3. **Claude calls browser tools** as needed (navigate, click, read page, type text, etc.)
4. **Web app POSTs to the bridge** (`/execute` with Bearer token auth)
5. **Bridge forwards the command** over WebSocket to the user's Chrome extension
6. **Extension's offscreen document** receives the command and relays it to the service worker via `chrome.runtime.sendMessage`
7. **Service worker executes** the Chrome API call (`chrome.tabs`, `chrome.scripting`) and returns the result
8. **Results flow back** through the chain: service worker -> offscreen -> bridge -> web app -> Claude -> user

### Why the offscreen document?

Chrome MV3 replaced persistent background pages with service workers that the browser can suspend at any time. A WebSocket connection in a service worker would be killed whenever Chrome decides to put it to sleep. The [offscreen document](https://developer.chrome.com/docs/extensions/reference/api/offscreen) is a hidden page that Chrome keeps alive as long as it exists, making it the right place for a persistent WebSocket. The service worker handles the actual Chrome API calls (which only it has access to), while the offscreen document handles the network connection.

### Browser tools

| Tool | Description |
|------|-------------|
| `navigate` | Open a URL in a new or existing tab |
| `get_page_content` | Read the text content, title, and URL of a tab |
| `click` | Click an element by CSS selector |
| `type_text` | Type text into an input element |
| `screenshot` | Capture the visible tab as a PNG |
| `list_tabs` | List all open tabs with IDs, URLs, and titles |
| `get_active_tab` | Get info about the currently active tab |

## Security

Toon Squad uses a layered authentication model so that no single secret is exposed to the browser.

### Authentication flow

```
User visits web app
  -> middleware sets toon-squad-uid cookie (random UUID, httpOnly)

Chrome extension starts
  -> service worker reads the cookie via chrome.cookies.get()
  -> calls GET /api/auth/session-info with the userId
  -> web app signs an HMAC-SHA256 token: userId:expiry:signature (5-min TTL)
  -> extension passes the token to the offscreen document
  -> offscreen connects to bridge via wss://...?token=<signed-token>
  -> bridge verifies the HMAC and expiry before accepting the WebSocket

User sends a chat message
  -> API route reads toon-squad-uid cookie
  -> calls POST /execute on bridge with Authorization: Bearer BRIDGE_SECRET
  -> bridge accepts (only the server-side web app has this secret)
```

### Key points

- **`BRIDGE_SECRET`** is the single shared secret between the web app and bridge. It never reaches the client.
- **HMAC tokens** are short-lived (5 min) and scoped to a single userId. The extension does not hold the secret -- it obtains a signed token from the web app.
- **The bridge verifies both channels separately**: WebSocket connections require a valid HMAC token; HTTP requests require the Bearer secret.
- **Rate limiting**: The chat API enforces per-user rate limiting (20 requests/minute). This is in-process only (each Vercel isolate has its own counter) -- swap in Redis/KV for production.

## Setup

### Prerequisites

- [Bun](https://bun.sh) (runtime and package manager)
- An [Anthropic API key](https://console.anthropic.com/)
- Chrome (for the extension)
- [Fly.io CLI](https://fly.io/docs/flyctl/install/) (for bridge deployment)
- [Vercel CLI](https://vercel.com/docs/cli) (for web app deployment, optional for local dev)

### Install dependencies

```bash
bun install
```

This is a Bun workspace monorepo. `bun install` at the root installs dependencies for all three apps.

### Configure environment variables

```bash
# Generate a shared secret for bridge authentication
BRIDGE_SECRET=$(openssl rand -hex 32)

# Web app config
cat > apps/web/.env.local <<EOF
ANTHROPIC_API_KEY=sk-ant-...
BRIDGE_URL=http://localhost:3333
BRIDGE_SECRET=$BRIDGE_SECRET
EOF

# Bridge config (must use the same BRIDGE_SECRET)
cat > apps/bridge/.env <<EOF
BRIDGE_SECRET=$BRIDGE_SECRET
EOF
```

### Install the Chrome extension

1. Open `chrome://extensions` in Chrome
2. Enable **Developer mode** (toggle in the top right)
3. Click **Load unpacked** and select the `apps/extension` directory
4. The extension will appear with the name "Toon Squad"

The extension ships with placeholder URLs that you need to update. For local development:
- `apps/extension/background.js` -- set `WEB_APP_ORIGIN` to `http://localhost:3000`
- `apps/extension/offscreen.js` -- set `BRIDGE_URL` to `ws://localhost:3333/extension` and `HEALTH_URL` to `http://localhost:3333/health`

For production, use your deployed URLs instead (see [Deployment](#deployment)).

### Run locally

```bash
./dev
```

This starts both the bridge (port 3333) and the Next.js dev server (port 3000). Open http://localhost:3000 to use the chat.

The chat UI shows a connection badge in the header -- it should say "Extension" (green) once the Chrome extension connects through the bridge. If it says "No Extension", check that:
1. The extension is loaded in `chrome://extensions`
2. The bridge is running (`http://localhost:3333/health` should return `{"status":"ok"}`)
3. You've visited `http://localhost:3000` at least once (to set the userId cookie)

## Deployment

| Component | Platform | Environment variables |
|-----------|----------|----------------------|
| Web App | Vercel | `ANTHROPIC_API_KEY`, `BRIDGE_URL`, `BRIDGE_SECRET` |
| Bridge | Fly.io | `BRIDGE_SECRET` (must match the value on Vercel) |
| Extension | Chrome (sideloaded) | Update URLs in `background.js` and `offscreen.js` |

### Deploy the bridge

```bash
cd apps/bridge
flyctl deploy
flyctl secrets set BRIDGE_SECRET=<your-secret>
```

### Deploy the web app

```bash
vercel deploy --prod
```

Set `BRIDGE_SECRET`, `BRIDGE_URL` (e.g., `https://toon-squad-bridge.fly.dev`), and `ANTHROPIC_API_KEY` in your Vercel project's environment variables.

### Update the extension

After deploying, update the URLs in the extension source and reload it in `chrome://extensions`:

- `apps/extension/background.js`: set `WEB_APP_ORIGIN` to your Vercel URL (no trailing slash)
- `apps/extension/offscreen.js`: set `BRIDGE_URL` to `wss://<your-bridge>.fly.dev/extension` and `HEALTH_URL` to `https://<your-bridge>.fly.dev/health`

## Tech stack

- **Runtime**: [Bun](https://bun.sh) (monorepo workspaces, bridge server, test runner)
- **Web framework**: [Next.js 16](https://nextjs.org/) on Vercel
- **AI**: [AI SDK v6](https://sdk.vercel.ai/) with `@ai-sdk/anthropic` (Claude Sonnet 4.6)
- **UI**: [AI Elements](https://sdk.vercel.ai/docs/ai-sdk-ui/ai-elements), [shadcn/ui](https://ui.shadcn.com/), Tailwind CSS v4
- **Extension**: Chrome Manifest V3, offscreen document API

## License

MIT -- see [LICENSE](LICENSE).
