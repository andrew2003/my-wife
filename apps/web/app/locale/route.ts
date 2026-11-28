import { NextResponse, type NextRequest } from "next/server";
import { safeNextPath } from "../../lib/locale";
import { LOCALE_COOKIE } from "../../lib/session";

/** Stores the chosen language in a cookie and returns to the same page. */
export function GET(request: NextRequest) {
  const lang = request.nextUrl.searchParams.get("lang");
  if (lang !== "vi" && lang !== "en") {
    return new NextResponse(null, { status: 400 });
  }
  const target = safeNextPath(
    request.nextUrl.searchParams.get("next"),
    request.headers.get("referer"),
    request.nextUrl.host,
  );
  const res = new NextResponse(null, { status: 303, headers: { location: target } });
  res.cookies.set(LOCALE_COOKIE, lang, { path: "/", maxAge: 60 * 60 * 24 * 365 });
  return res;
}
