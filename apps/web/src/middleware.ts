import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const COOKIE_NAME = "toon-squad-uid";

export function middleware(request: NextRequest) {
  const existing = request.cookies.get(COOKIE_NAME)?.value;
  if (existing) return NextResponse.next();

  // Set a persistent userId cookie on first visit
  const response = NextResponse.next();
  response.cookies.set(COOKIE_NAME, crypto.randomUUID(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 365, // 1 year
    path: "/",
  });
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
