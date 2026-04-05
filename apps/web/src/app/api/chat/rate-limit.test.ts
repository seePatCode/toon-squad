import { test, expect } from "bun:test";

// Inline the rate limiter logic for unit testing
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 20;

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(userId);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(userId, {
      count: 1,
      resetAt: now + RATE_LIMIT_WINDOW_MS,
    });
    return true;
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return false;
  }

  entry.count++;
  return true;
}

test("allows requests under the limit", () => {
  const userId = "test-user-1";
  for (let i = 0; i < RATE_LIMIT_MAX; i++) {
    expect(checkRateLimit(userId)).toBe(true);
  }
});

test("blocks requests over the limit", () => {
  const userId = "test-user-2";
  for (let i = 0; i < RATE_LIMIT_MAX; i++) {
    checkRateLimit(userId);
  }
  expect(checkRateLimit(userId)).toBe(false);
  expect(checkRateLimit(userId)).toBe(false);
});

test("different users have separate limits", () => {
  const userA = "test-user-3a";
  const userB = "test-user-3b";

  for (let i = 0; i < RATE_LIMIT_MAX; i++) {
    checkRateLimit(userA);
  }

  // User A is blocked
  expect(checkRateLimit(userA)).toBe(false);
  // User B is not
  expect(checkRateLimit(userB)).toBe(true);
});

test("resets after window expires", () => {
  const userId = "test-user-4";

  for (let i = 0; i < RATE_LIMIT_MAX; i++) {
    checkRateLimit(userId);
  }
  expect(checkRateLimit(userId)).toBe(false);

  // Manually expire the window
  const entry = rateLimitMap.get(userId)!;
  entry.resetAt = Date.now() - 1;

  expect(checkRateLimit(userId)).toBe(true);
});
