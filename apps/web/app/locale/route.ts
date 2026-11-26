import { NextResponse, type NextRequest } from "next/server";
import { LOCALE_COOKIE } from "../../lib/session";

/** Stores the chosen locale in a cookie and returns to the start page. */
export function GET(request: NextRequest) {
  const to = request.nextUrl.searchParams.get("to");
  const res = NextResponse.redirect(new URL("/", request.url));
  if (to === "vi" || to === "en") {
    res.cookies.set(LOCALE_COOKIE, to, { path: "/", maxAge: 60 * 60 * 24 * 365 });
  }
  return res;
}
