// Extension Bridge — multi-tenant Bun server that bridges between
// the Next.js app and Chrome extensions via WebSocket.
//
// Security:
// - /execute requires BRIDGE_SECRET in Authorization header
// - /health with userId requires BRIDGE_SECRET
// - WebSocket /extension requires a signed connection token (HMAC)

const PORT = parseInt(process.env.PORT || "3333");
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || "";
const TOKEN_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

if (!BRIDGE_SECRET) {
  console.warn(
    "[bridge] WARNING: BRIDGE_SECRET not set. Bridge is insecure!",
  );
}

const userConnections = new Map<string, any>();
const pendingCommands = new Map<
  string,
  { resolve: (result: unknown) => void; reject: (err: Error) => void }
>();

// --- Token Verification ---

async function verifyToken(
  token: string,
): Promise<{ valid: boolean; userId?: string }> {
  if (!BRIDGE_SECRET) return { valid: false };

  const parts = token.split(":");
  if (parts.length !== 3) return { valid: false };

  const [userId, expiryStr, signature] = parts;
  const expiry = parseInt(expiryStr);

  if (isNaN(expiry) || Date.now() > expiry) {
    return { valid: false }; // expired
  }

  const data = `${userId}:${expiryStr}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(BRIDGE_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data),
  );
  const expectedSig = Buffer.from(sig).toString("hex");

  if (signature !== expectedSig) {
    return { valid: false };
  }

  return { valid: true, userId };
}

function checkBridgeSecret(req: Request): boolean {
  if (!BRIDGE_SECRET) return false;
  const auth = req.headers.get("authorization");
  return auth === `Bearer ${BRIDGE_SECRET}`;
}

// --- Server ---

Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);

    // Health check
    if (url.pathname === "/health") {
      const userId = url.searchParams.get("userId");
      if (userId) {
        // Per-user status requires auth
        if (!checkBridgeSecret(req)) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
        return Response.json({
          status: "ok",
          extension: userConnections.has(userId),
        });
      }
      // General health (no user info leaked)
      return Response.json({ status: "ok" });
    }

    // Execute a browser command (called by Next.js API routes)
    if (url.pathname === "/execute" && req.method === "POST") {
      if (!checkBridgeSecret(req)) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      return handleExecute(req);
    }

    // Extension WebSocket upgrade — requires signed token
    if (url.pathname === "/extension") {
      const token = url.searchParams.get("token");
      if (!token) {
        return new Response("Missing token", { status: 400 });
      }

      // Verify token async, then upgrade
      return verifyToken(token).then(({ valid, userId }) => {
        if (!valid || !userId) {
          return new Response("Invalid or expired token", { status: 403 });
        }
        if (
          this.upgrade(req, { data: { role: "extension", userId } } as any)
        ) {
          return undefined as any;
        }
        return new Response("WebSocket upgrade failed", { status: 400 });
      });
    }

    return new Response("Not Found", { status: 404 });
  },
  websocket: {
    open(ws) {
      const userId = (ws.data as any).userId;
      const existing = userConnections.get(userId);
      if (existing) {
        // Close old connection before replacing
        try {
          existing.close(1000, "Replaced by new connection");
        } catch {
          // already closed
        }
      }
      userConnections.set(userId, ws);
      console.log(
        `[bridge] Extension connected for user ${userId} (${userConnections.size} total)`,
      );
    },
    message(_ws, raw) {
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }

      if (msg.type === "browser_result" && msg.id) {
        const pending = pendingCommands.get(msg.id);
        if (pending) {
          pendingCommands.delete(msg.id);
          pending.resolve(msg.result);
        }
      }
    },
    close(ws) {
      const userId = (ws.data as any).userId;
      // Only delete if this is still the active connection
      if (userConnections.get(userId) === ws) {
        userConnections.delete(userId);
        // Reject any in-flight commands for this user
        for (const [id, pending] of pendingCommands) {
          pendingCommands.delete(id);
          pending.reject(new Error("Extension disconnected"));
        }
      }
      console.log(
        `[bridge] Extension disconnected for user ${userId} (${userConnections.size} total)`,
      );
    },
  },
});

async function handleExecute(req: Request): Promise<Response> {
  const { action, params, userId } = (await req.json()) as {
    action: string;
    params: Record<string, unknown>;
    userId: string;
  };

  if (!userId || !action) {
    return Response.json(
      { error: "Missing userId or action" },
      { status: 400 },
    );
  }

  const extensionWs = userConnections.get(userId);
  if (!extensionWs) {
    return Response.json(
      { error: "No extension connected for this user" },
      { status: 503 },
    );
  }

  try {
    const result = await new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      pendingCommands.set(id, { resolve, reject });
      extensionWs.send(
        JSON.stringify({ type: "browser_command", id, action, params }),
      );
      setTimeout(() => {
        if (pendingCommands.has(id)) {
          pendingCommands.delete(id);
          reject(new Error(`Browser command timed out: ${action}`));
        }
      }, 30000);
    });

    return Response.json({ result });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}

console.log(`[bridge] Multi-tenant bridge running on port ${PORT}`);
