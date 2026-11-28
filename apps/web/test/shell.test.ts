import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi as vitest } from "vitest";
import en from "../locales/en.json";
import vi from "../locales/vi.json";
import { AppShell } from "../components/app-shell";
import { SignInPage } from "../components/sign-in-page";
import { NAV_ITEMS } from "../lib/nav";
import { fetchCurrentUser, type CurrentUser } from "../lib/session";

const user: CurrentUser = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "an@example.com",
  state: "active",
  role: "user",
  locale: "vi",
  lastSeenAt: null,
};

describe("sign-in page (anonymous visitor, UI_LANGUAGE=vi)", () => {
  it("renders Vietnamese strings from the locale file", () => {
    const html = renderToStaticMarkup(
      createElement(SignInPage, { locale: "vi", loginMethod: "google" }),
    );
    expect(html).toContain(vi["signin.title"]);
    expect(html).toContain(vi["signin.google"]);
    expect(html).toContain(vi["signin.invitation_only"]);
    expect(html).not.toContain(en["signin.title"]);
  });

  it("offers the magic link action when LOGIN_METHOD is magic_link", () => {
    const html = renderToStaticMarkup(
      createElement(SignInPage, { locale: "en", loginMethod: "magic_link" }),
    );
    expect(html).toContain(en["signin.magic_link"]);
    expect(html).not.toContain(en["signin.google"]);
  });

  it("has a locale switch", () => {
    const html = renderToStaticMarkup(
      createElement(SignInPage, { locale: "vi", loginMethod: "google" }),
    );
    expect(html).toContain("/locale?lang=en");
  });
});

describe("app shell (signed-in user)", () => {
  it("shows navigation and strings from the locale file", () => {
    const html = renderToStaticMarkup(
      createElement(AppShell, {
        locale: "vi",
        user,
        children: createElement("p", null, "content"),
      }),
    );
    for (const item of NAV_ITEMS.filter((i) => !i.adminOnly)) {
      expect(html).toContain(vi[item.labelKey as keyof typeof vi]);
      expect(html).toContain(`href="${item.href}"`);
    }
    expect(html).toContain("content");
    expect(html).toContain(user.email);
  });

  it("every navigation label exists in both locale files", () => {
    for (const item of NAV_ITEMS) {
      expect(vi).toHaveProperty([item.labelKey]);
      expect(en).toHaveProperty([item.labelKey]);
    }
  });
});

describe("fetchCurrentUser", () => {
  it("returns null without a session cookie and does not call the gateway", async () => {
    const f = vitest.fn();
    expect(await fetchCurrentUser(undefined, "http://gw", f as never)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it("returns the user and forwards the mw_session cookie", async () => {
    const f = vitest.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify({ data: { user } }), { status: 200 }),
    );
    expect(await fetchCurrentUser("tok", "http://gw", f as never)).toEqual(user);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("http://gw/api/me");
    expect(JSON.stringify(init.headers)).toContain("mw_session=tok");
  });

  it("returns null on 401 or a network error", async () => {
    const f401 = vitest.fn(async () => new Response("{}", { status: 401 }));
    expect(await fetchCurrentUser("tok", "http://gw", f401 as never)).toBeNull();
    const fErr = vitest.fn(async () => {
      throw new Error("down");
    });
    expect(await fetchCurrentUser("tok", "http://gw", fErr as never)).toBeNull();
  });
});
