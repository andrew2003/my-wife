import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/locale/route";
import { resolveLocale } from "../lib/locale";

afterEach(() => vi.unstubAllGlobals());

describe("resolveLocale for a signed-in user", () => {
  it("lets the profile win over a stale cookie", () => {
    expect(
      resolveLocale({ cookie: "vi", profile: "en", signedIn: true, acceptLanguage: "vi" }),
    ).toBe("en");
  });

  it("keeps the cookie first for a visitor without a profile", () => {
    expect(resolveLocale({ cookie: "en", acceptLanguage: "vi" })).toBe("en");
  });

  it("falls back to the cookie when a signed-in profile has no valid locale", () => {
    expect(resolveLocale({ cookie: "en", profile: "xx", signedIn: true })).toBe("en");
  });
});

describe("/locale route profile write", () => {
  const call = (headers: Record<string, string> = {}) =>
    GET(new NextRequest("https://app.test/locale?lang=en&next=/budget", { headers }));

  it("writes the profile through the gateway when a session exists", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await call({ cookie: "mw_session=tok" });
    expect(res.status).toBe(303);
    expect(res.cookies.get("mw_locale")?.value).toBe("en");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/profile\/locale$/);
    expect(init.method).toBe("PUT");
    expect(init.body).toBe(JSON.stringify({ locale: "en" }));
    expect((init.headers as Record<string, string>).cookie).toBe("mw_session=tok");
  });

  it("does not call the gateway without a session", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await call();
    expect(res.status).toBe(303);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still redirects with the cookie when the gateway fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("down");
      }),
    );
    const res = await call({ cookie: "mw_session=tok" });
    expect(res.status).toBe(303);
    expect(res.cookies.get("mw_locale")?.value).toBe("en");
  });
});
