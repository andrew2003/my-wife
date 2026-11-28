import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import en from "../locales/en.json";
import vi_ from "../locales/vi.json";

const user = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "an@example.test",
  role: "user",
  locale: "en",
  lastSeenAt: null,
};

vi.mock("../lib/request-context", () => ({
  getRequestContext: async () => ({
    locale: "en",
    user,
    appearance: { skin: "navy", mode: "system" },
  }),
  getRequestLocale: async () => "en",
}));

const enValues = new Set(Object.values(en));
const viOnly = Object.entries(vi_)
  .filter(([key, value]) => en[key as keyof typeof en] !== value && !enValues.has(value))
  .map(([, value]) => value);

describe("pages render in the request locale", () => {
  it("layout with a home page: html lang is en and no vi catalog value appears", async () => {
    const { default: RootLayout } = await import("../app/layout");
    const { default: HomePage } = await import("../app/page");
    const page = await HomePage();
    const tree = await RootLayout({ children: page });
    const html = renderToStaticMarkup(createElement("div", null, tree));
    expect(html).toContain('lang="en"');
    expect(html).toContain(en["home.title"]);
    const visible = html.replace(/<[^>]*>/g, "\n");
    for (const value of viOnly) expect(visible).not.toContain(value);
  });
});

describe("catalogs", () => {
  it("vi and en have identical keys", () => {
    expect(Object.keys(vi_).sort()).toEqual(Object.keys(en).sort());
  });
});
