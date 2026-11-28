import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GET } from "../app/locale/route";
import { LocaleSwitch } from "../components/locale-switch";
import { resolveLocale, safeNextPath } from "../lib/locale";

const long = `/${"a".repeat(600)}`;

describe("safeNextPath (table-driven)", () => {
  const fallbacks: Array<[string, string | null]> = [
    ["protocol-relative", "//evil.com"],
    ["backslash host", "/\\evil.com"],
    ["absolute url", "https://evil.com"],
    ["javascript scheme", "javascript:alert(1)"],
    ["encoded double slash", "%2F%2Fevil.com"],
    ["slash then encoded slash", "/%2Fevil.com"],
    ["slash then encoded backslash", "/%5Cevil.com"],
    ["triple slash", "///evil.com"],
    ["control character", "/\t/evil.com"],
    ["bare host", "evil.com"],
    ["empty", ""],
    ["null", null],
    ["600 characters", long],
    ["at sign in first segment", "/me@evil.com"],
    ["double encoded", "/%252F%252Fevil.com"],
  ];
  for (const [name, value] of fallbacks) {
    it(`falls back to / for ${name}`, () => {
      expect(safeNextPath(value, null, "app.test")).toBe("/");
    });
  }

  for (const ok of ["/budget", "/schedule/today?day=2026-11-28", "/settings/models#keys"]) {
    it(`accepts ${ok}`, () => {
      expect(safeNextPath(ok, null, "app.test")).toBe(ok);
    });
  }

  it("uses a same-origin Referer path when next is unsafe", () => {
    expect(safeNextPath("//evil.com", "https://app.test/budget?x=1", "app.test")).toBe(
      "/budget?x=1",
    );
  });

  it("ignores a cross-origin Referer", () => {
    expect(safeNextPath(null, "https://evil.com/budget", "app.test")).toBe("/");
  });
});

describe("resolveLocale", () => {
  it("prefers the cookie, then the profile, then Accept-Language, then the default", () => {
    expect(resolveLocale({ cookie: "en", profile: "vi", acceptLanguage: "vi" })).toBe("en");
    expect(resolveLocale({ cookie: undefined, profile: "en", acceptLanguage: "vi" })).toBe("en");
    expect(resolveLocale({ cookie: "xx", acceptLanguage: "en-US,en;q=0.9" })).toBe("en");
    expect(resolveLocale({ acceptLanguage: "fr" })).toBe("vi");
  });
});

describe("/locale route", () => {
  const call = (qs: string, headers: Record<string, string> = {}) =>
    GET(new NextRequest(`https://app.test/locale${qs}`, { headers }));

  it("sets the cookie and redirects to a relative path", async () => {
    const res = await call("?lang=en&next=/budget");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/budget");
    expect(res.cookies.get("mw_locale")?.value).toBe("en");
  });

  it("redirects an unsafe next to /", async () => {
    const res = await call("?lang=vi&next=//evil.com");
    expect(res.headers.get("location")).toBe("/");
  });

  it("falls back to the same-origin Referer", async () => {
    const res = await call("?lang=vi", { referer: "https://app.test/debts" });
    expect(res.headers.get("location")).toBe("/debts");
  });

  it("rejects an unknown language with 400", async () => {
    expect((await call("?lang=fr")).status).toBe(400);
  });
});

describe("LocaleSwitch", () => {
  it("highlights only the active language", () => {
    const html = renderToStaticMarkup(createElement(LocaleSwitch, { locale: "en" }));
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toContain("lang=vi");
    expect(html).toContain("lang=en");
    const active = html.split("<a").find((s) => s.includes('aria-pressed="true"')) ?? "";
    expect(active).toContain("EN");
  });
});

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === "test") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

describe("UI_LANGUAGE", () => {
  it("is read in exactly one file", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const readers = walk(root).filter((f) => /env\.UI_LANGUAGE/.test(readFileSync(f, "utf8")));
    expect(readers.map((f) => f.slice(root.length + 1))).toEqual(["lib/i18n.ts"]);
  });
});
