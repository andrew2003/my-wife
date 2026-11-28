import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../locales/en.json";
import vi from "../locales/vi.json";
import { AppShell } from "../components/app-shell";
import { NAV_AREAS, EXCLUDED_ROUTES, areaForRoute, visibleAreas } from "../lib/nav";
import type { CurrentUser } from "../lib/session";

const user: CurrentUser = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "an@example.com",
  state: "active",
  role: "user",
  locale: "vi",
  lastSeenAt: null,
};
const admin: CurrentUser = { ...user, role: "admin" };

const appDir = join(import.meta.dirname, "..", "app");

function pageRoutes(dir = appDir, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (!statSync(full).isDirectory()) {
      if (name === "page.tsx") out.push(prefix || "/");
      continue;
    }
    out.push(...pageRoutes(full, `${prefix}/${name}`));
  }
  return out;
}

const render = (u: CurrentUser, locale: "vi" | "en" = "en") =>
  renderToStaticMarkup(h(AppShell, { locale, user: u, children: h("p", null, "content") }));

describe("route-to-area map", () => {
  it("places every page route in exactly one area or the excluded list", () => {
    for (const route of pageRoutes()) {
      const hits = NAV_AREAS.filter((a) => a.routes.includes(route)).map((a) => a.id);
      const excluded = EXCLUDED_ROUTES.includes(route);
      expect(hits.length + (excluded ? 1 : 0), route).toBe(1);
      if (!excluded) expect(areaForRoute(route)).toBe(hits[0]);
    }
  });

  it("matches concrete paths, including dynamic segments", () => {
    expect(areaForRoute("/receipts/abc-123")).toBe("budget");
    expect(areaForRoute("/schedule/review")).toBe("schedule");
    expect(areaForRoute("/inbox")).toBe("today");
    expect(areaForRoute("/")).toBe("today");
    expect(areaForRoute("/onboarding")).toBeNull();
  });
});

describe("shell rendering", () => {
  it("hides admin items for a non-admin user", () => {
    expect(visibleAreas("user").flatMap((a) => a.items.map((i) => i.href))).not.toContain("/admin");
    expect(render(user)).not.toContain('href="/admin"');
    expect(render(admin)).toContain('href="/admin"');
  });

  it("renders top bar, pill nav, bottom bar and the More sheet from locale files", () => {
    for (const locale of ["vi", "en"] as const) {
      const html = render(user, locale);
      const dict = locale === "vi" ? vi : en;
      expect(html).toContain("shell-topbar");
      expect(html).toContain("pill-nav");
      expect(html).toContain("bottom-bar");
      expect(html).toContain(dict["shell.more"]);
      expect(html).toContain(dict["nav.label"]);
      expect(html).toContain("content");
    }
  });

  it("every area and item label exists in both locale files", () => {
    for (const area of NAV_AREAS) {
      expect(en).toHaveProperty([area.labelKey]);
      expect(vi).toHaveProperty([area.labelKey]);
      for (const item of area.items) {
        expect(en).toHaveProperty([item.labelKey]);
        expect(vi).toHaveProperty([item.labelKey]);
      }
    }
    for (const k of ["shell.more", "shell.close", "shell.area_nav"]) {
      expect(en).toHaveProperty([k]);
      expect(vi).toHaveProperty([k]);
    }
  });

  it("every nav item belongs to its area", () => {
    for (const area of NAV_AREAS)
      for (const item of area.items) expect(areaForRoute(item.href)).toBe(area.id);
  });
});

describe("no horizontal scroll at 360 and 1440 px", () => {
  const css = readFileSync(join(appDir, "globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  it("clips horizontal overflow on the page and never scrolls the nav sideways", () => {
    expect(css).toMatch(/body\s*{[^}]*overflow-x:\s*clip/);
    expect(css).toMatch(/\.shell\s*{[^}]*max-width:\s*100%/);
    expect(css).not.toMatch(
      /\.(pill-nav|bottom-bar|shell-topbar)[^{]*{[^}]*overflow-x:\s*(auto|scroll)/,
    );
    expect(css).toMatch(/\.shell-content\s*{[^}]*min-width:\s*0/);
  });
  it("uses safe-area padding on the bottom bar and swaps nav at the phone breakpoint", () => {
    expect(css).toMatch(/\.bottom-bar\s*{[^}]*env\(safe-area-inset-bottom\)/);
    expect(css).toMatch(/@media \(max-width: 47\.99rem\)/);
  });
});
