import { test, expect } from "bun:test";

const BRIDGE_SECRET = "test-secret-key-for-testing";

async function signToken(
  userId: string,
  ttlMs: number = 5 * 60 * 1000,
): Promise<string> {
  const expiry = Date.now() + ttlMs;
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
  return `${userId}:${expiry}:${Buffer.from(sig).toString("hex")}`;
}

async function verifyToken(
  token: string,
): Promise<{ valid: boolean; userId?: string }> {
  const parts = token.split(":");
  if (parts.length !== 3) return { valid: false };

  const [userId, expiryStr, signature] = parts;
  const expiry = parseInt(expiryStr);

  if (isNaN(expiry) || Date.now() > expiry) {
    return { valid: false };
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

test("valid token verifies successfully", async () => {
  const token = await signToken("user-123");
  const result = await verifyToken(token);
  expect(result.valid).toBe(true);
  expect(result.userId).toBe("user-123");
});

test("expired token is rejected", async () => {
  const token = await signToken("user-123", -1000); // already expired
  const result = await verifyToken(token);
  expect(result.valid).toBe(false);
});

test("tampered signature is rejected", async () => {
  const token = await signToken("user-123");
  const tampered = token.slice(0, -4) + "dead";
  const result = await verifyToken(tampered);
  expect(result.valid).toBe(false);
});

test("tampered userId is rejected", async () => {
  const token = await signToken("user-123");
  const parts = token.split(":");
  parts[0] = "user-evil";
  const tampered = parts.join(":");
  const result = await verifyToken(tampered);
  expect(result.valid).toBe(false);
});

test("malformed token is rejected", async () => {
  expect((await verifyToken("")).valid).toBe(false);
  expect((await verifyToken("just-one-part")).valid).toBe(false);
  expect((await verifyToken("a:b")).valid).toBe(false);
  expect((await verifyToken("a:notanumber:c")).valid).toBe(false);
});
