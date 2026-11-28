import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

let cookieValues: Record<string, string> = {};
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (n in cookieValues ? { value: cookieValues[n] } : undefined),
  }),
  headers: async () => new Headers(),
}));
vi.mock("../lib/session", async (orig) => ({
  ...(await orig<typeof import("../lib/session")>()),
  fetchCurrentUser: async () => null,
}));

async function render() {
  const { default: RootLayout } = await import("../app/layout");
  const tree = await RootLayout({ children: null });
  return renderToStaticMarkup(createElement("div", null, tree));
}

describe("root layout appearance", () => {
  it("sets data-skin and data-mode from the cookies", async () => {
    cookieValues = { mw_skin: "hanfu", mw_mode: "dark" };
    const html = await render();
    expect(html).toContain('data-skin="hanfu"');
    expect(html).toContain('data-mode="dark"');
    expect(html).not.toContain("<script");
  });
  it("system mode sets no data-mode", async () => {
    cookieValues = { mw_skin: "street", mw_mode: "system" };
    const html = await render();
    expect(html).toContain('data-skin="street"');
    expect(html).not.toContain("data-mode");
  });
  it("defaults to navy and system", async () => {
    cookieValues = {};
    const html = await render();
    expect(html).toContain('data-skin="navy"');
    expect(html).not.toContain("data-mode");
  });
});
