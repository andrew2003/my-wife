import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../locales/en.json";
import vi from "../locales/vi.json";
import { AppearanceView } from "../components/appearance-view";
import { Mascot } from "../components/mascot";
import {
  APPEARANCE_KEYS,
  appearanceCookies,
  loadAppearance,
  saveAppearance,
} from "../lib/appearance";
import { NAV_ITEMS } from "../lib/nav";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("cookies", () => {
  it("writes both cookies for one year, Lax, path /", () => {
    const [skin, mode] = appearanceCookies({ skin: "silver", mode: "dark" }, false);
    expect(skin).toBe("mw_skin=silver; path=/; max-age=31536000; samesite=lax");
    expect(mode).toBe("mw_mode=dark; path=/; max-age=31536000; samesite=lax");
  });
  it("adds Secure over HTTPS", () => {
    expect(appearanceCookies({ skin: "navy", mode: "system" }, true)[0]).toMatch(/; secure$/);
  });
});

describe("saveAppearance", () => {
  it("mirrors both keys to the profile and reports success", async () => {
    const calls: Array<{ key: string; value: unknown }> = [];
    const ok = await saveAppearance({ skin: "hanfu", mode: "light" }, async (_u, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return json(200, { ok: true });
    });
    expect(ok).toBe(true);
    expect(calls).toEqual([
      { key: APPEARANCE_KEYS.skin, value: "hanfu" },
      { key: APPEARANCE_KEYS.mode, value: "light" },
    ]);
  });
  it("reports failure when the profile write fails", async () => {
    expect(await saveAppearance({ skin: "navy", mode: "dark" }, async () => json(500, {}))).toBe(
      false,
    );
  });
});

describe("loadAppearance", () => {
  it("reads valid values and falls back to defaults for bad ones", async () => {
    const res = await loadAppearance(async () =>
      json(200, {
        ok: true,
        data: { values: { "appearance.skin": "street", "appearance.mode": "x" } },
      }),
    );
    expect(res).toEqual({ status: "ready", appearance: { skin: "street", mode: "system" } });
  });
  it("errors on a failed request", async () => {
    expect(await loadAppearance(async () => json(500, {}))).toEqual({ status: "error" });
  });
});

describe("view", () => {
  const base = {
    locale: "en" as const,
    status: "ready" as const,
    appearance: { skin: "hanfu" as const, mode: "system" as const },
    saveState: "idle" as const,
    onChange: () => {},
    onSave: () => {},
    onRefresh: () => {},
  };
  const html = (over = {}) =>
    renderToStaticMarkup(createElement(AppearanceView, { ...base, ...over }));
  it("marks the active skin and mode", () => {
    const out = html();
    expect(out).toContain(en["appearance.skin.hanfu"]);
    expect(out.match(/aria-pressed="true"/g)).toHaveLength(2);
  });
  it("has loading and error states", () => {
    expect(html({ status: "loading" })).toContain(en["appearance.loading"]);
    expect(html({ status: "error" })).toContain(en["appearance.error"]);
  });
  it("is in the more menu and both locales have every key", () => {
    expect(NAV_ITEMS.some((i) => i.href === "/settings/appearance")).toBe(true);
    for (const k of Object.keys(en).filter((k) => k.startsWith("appearance."))) {
      expect(vi).toHaveProperty([k]);
    }
  });
});

describe("system mode art", () => {
  it("uses a prefers-color-scheme dark source with no script", () => {
    const out = renderToStaticMarkup(
      createElement(Mascot, { artKey: "dress-full", size: "medium", alt: "a", available: true }),
    );
    expect(out).toContain('media="(prefers-color-scheme: dark)"');
    expect(out).not.toContain("<script");
  });
});
