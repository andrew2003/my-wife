import { NextResponse, type NextRequest } from "next/server";
import { resolveGatewayUrl } from "../../lib/gateway-url.mjs";
import { safeNextPath } from "../../lib/locale";
import { LOCALE_COOKIE, SESSION_COOKIE } from "../../lib/session";

/**
 * Stores the chosen language in a cookie and, for a signed-in user, in the profile
 * (through the gateway), then returns to the same page. A failed profile write is not fatal:
 * the cookie still applies and the next switch retries.
 */
export async function GET(request: NextRequest) {
  const lang = request.nextUrl.searchParams.get("lang");
  if (lang !== "vi" && lang !== "en") {
    return new NextResponse(null, { status: 400 });
  }
  const target = safeNextPath(
    request.nextUrl.searchParams.get("next"),
    request.headers.get("referer"),
    request.nextUrl.host,
  );
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (token) {
    try {
      await fetch(`${resolveGatewayUrl(process.env)}/api/profile/locale`, {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${token}` },
        body: JSON.stringify({ locale: lang }),
        cache: "no-store",
      });
    } catch {
      // The cookie below still carries the choice.
    }
  }
  const res = new NextResponse(null, { status: 303, headers: { location: target } });
  res.cookies.set(LOCALE_COOKIE, lang, { path: "/", maxAge: 60 * 60 * 24 * 365 });
  return res;
}
