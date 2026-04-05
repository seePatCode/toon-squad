import { cookies, headers } from "next/headers";

const COOKIE_NAME = "toon-squad-uid";
const BRIDGE_SECRET = process.env.BRIDGE_SECRET ?? "";
const TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function signToken(userId: string): Promise<string> {
  const expiry = Date.now() + TOKEN_TTL_MS;
  const data = `${userId}:${expiry}`;
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
  const signature = Buffer.from(sig).toString("hex");
  return `${userId}:${expiry}:${signature}`;
}

export async function GET() {
  // Try cookie first (same-origin browser requests),
  // then X-User-Id header (from Chrome extension which can't send cross-origin cookies)
  const cookieStore = await cookies();
  const headerStore = await headers();
  const userId =
    cookieStore.get(COOKIE_NAME)?.value ||
    headerStore.get("x-user-id");

  if (!userId) {
    return Response.json({ authenticated: false });
  }

  if (!BRIDGE_SECRET) {
    // Fallback for local dev without secret
    return Response.json({
      authenticated: true,
      userId,
      token: userId,
    });
  }

  const token = await signToken(userId);
  return Response.json({
    authenticated: true,
    token,
  });
}
