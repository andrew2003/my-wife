import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../locales/en.json";
import vi from "../locales/vi.json";
import { CompanionPanelView } from "../components/companion-panel-view";
import { SpeechBubble } from "../components/speech-bubble";
import { AppShell } from "../components/app-shell";
import { loadRemark, remarkScreen, showsCompanion } from "../lib/companion";
import type { CurrentUser } from "../lib/session";

const ok = (data: unknown) =>
  Promise.resolve(new Response(JSON.stringify({ ok: true, data }), { status: 200 }));

describe("which screens get the panel", () => {
  it("skips the dashboard and the focus session only", () => {
    expect(showsCompanion("/")).toBe(false);
    expect(showsCompanion("/monitor")).toBe(false);
    for (const p of ["/budget", "/schedule", "/schedule/today", "/settings/models", "/inbox"]) {
      expect(showsCompanion(p), p).toBe(true);
    }
  });
  it("also skips sub-routes of the focus session but not look-alike paths", () => {
    expect(showsCompanion("/monitor/session")).toBe(false);
    expect(showsCompanion("/monitoring")).toBe(true);
  });
  it("derives a contract-valid screen key from the path", () => {
    expect(remarkScreen("/budget")).toBe("budget");
    expect(remarkScreen("/schedule/today")).toBe("schedule-today");
    expect(remarkScreen("/receipts/abc-123")).toBe("receipts");
    for (const p of ["/budget", "/settings/models", "/cycle-close"]) {
      expect(remarkScreen(p)).toMatch(/^[a-z][a-z0-9_-]{0,63}$/);
    }
  });
});

describe("loadRemark", () => {
  it("posts the screen and locale and returns the cached or generated text", async () => {
    let seen: { url: string; body: unknown } | null = null;
    const res = await loadRemark("budget", "en", (url, init) => {
      seen = { url, body: JSON.parse(String(init?.body)) };
      return ok({ text: "Nice week.", source: "model" });
    });
    expect(res).toEqual({ status: "ready", text: "Nice week.", source: "model" });
    expect(seen).toEqual({
      url: "/api/ai/remarks",
      body: { screen: "budget", facts: {}, locale: "en" },
    });
  });
  it("reports an error on a failed request or a bad shape", async () => {
    expect(await loadRemark("budget", "vi", () => Promise.reject(new Error("x")))).toEqual({
      status: "error",
    });
    expect(
      await loadRemark("budget", "vi", () => Promise.resolve(new Response("", { status: 502 }))),
    ).toEqual({ status: "error" });
    expect(await loadRemark("budget", "vi", () => ok({ nope: 1 }))).toEqual({ status: "error" });
  });
});

describe("CompanionPanelView", () => {
  const render = (
    status: "loading" | "ready" | "error",
    text?: string,
    locale: "vi" | "en" = "en",
  ) =>
    renderToStaticMarkup(
      h(CompanionPanelView, { locale, status, ...(text ? { text } : {}), artAvailable: false }),
    );
  it("shows the remark when ready", () => {
    const html = render("ready", "Keep going.");
    expect(html).toContain("Keep going.");
    expect(html).toContain('role="status"');
  });
  it("shows typing dots while loading", () => {
    const html = render("loading");
    expect(html).toContain("speech-typing");
    expect(html).toContain(en["companion.loading"]);
  });
  it("shows the fixed fallback sentence on error, in both locales", () => {
    expect(render("error")).toContain(en["companion.fallback"]);
    expect(render("error", undefined, "vi")).toContain(vi["companion.fallback"]);
  });
  it("labels the panel", () => {
    expect(render("ready", "x")).toContain(en["companion.label"]);
  });
});

describe("SpeechBubble", () => {
  it("renders text in a live region", () => {
    const html = renderToStaticMarkup(h(SpeechBubble, { text: "Hi", typingLabel: "typing" }));
    expect(html).toContain("Hi");
    expect(html).toContain('role="status"');
  });
});

describe("shell integration", () => {
  const user: CurrentUser = {
    id: "11111111-1111-4111-8111-111111111111",
    email: "an@example.com",
    state: "active",
    role: "user",
    locale: "vi",
    lastSeenAt: null,
  };
  it("lays the page and the panel host side by side", () => {
    const html = renderToStaticMarkup(
      h(AppShell, { locale: "en", user, children: h("p", null, "content") }),
    );
    expect(html).toContain("shell-body");
  });
});
