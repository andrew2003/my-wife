import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../locales/en.json";
import vi_ from "../locales/vi.json";
import { artDirectory, readCredits } from "../lib/art";
import { serveArt } from "../lib/art-serve";
import { areaForRoute } from "../lib/nav";
import { CreditsView } from "../components/credits-view";
import { Mascot } from "../components/mascot";
import type { CurrentUser } from "../lib/session";

const user = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "an@example.test",
  state: "active",
  role: "user",
  locale: "en",
  lastSeenAt: null,
};
const signedIn = async (): Promise<CurrentUser | null> => user as CurrentUser;
const signedOut = async (): Promise<CurrentUser | null> => null;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mw-art-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const req = (cookie = "mw_session=t") => new Request("http://x/art/k", { headers: { cookie } });
const serve = (key: string, query = "", fetchUser = signedIn, artDir: string | null = dir) =>
  serveArt(req(), key, new URLSearchParams(query), { dir: artDir, fetchUser });

describe("art directory", () => {
  it("is null when MASCOT_ART_DIR is unset or blank", () => {
    expect(artDirectory({})).toBeNull();
    expect(artDirectory({ MASCOT_ART_DIR: "  " })).toBeNull();
    expect(artDirectory({ MASCOT_ART_DIR: "/a/b" })).toBe("/a/b");
  });
});

describe("serving art", () => {
  it("answers 401 to a signed-out request, before touching the directory", async () => {
    writeFileSync(join(dir, "logo-512.png"), "png");
    expect((await serve("logo-512", "", signedOut)).status).toBe(401);
    expect((await serve("nope", "", signedOut, null)).status).toBe(401);
  });

  it("refuses path traversal and odd keys", async () => {
    writeFileSync(join(dir, "secret.txt"), "s");
    for (const key of [
      "../secret",
      "..",
      "a/b",
      "a\\b",
      ".hidden",
      "%2e%2e",
      "x\0y",
      "credits.txt",
    ]) {
      expect((await serve(key)).status, key).toBe(400);
    }
    expect((await serve("dress-full", "size=../../etc")).status).toBe(400);
  });

  it("serves originals when the directory has only originals", async () => {
    writeFileSync(join(dir, "dress-full.png"), "ORIGINAL");
    for (const size of ["small", "medium", "large"]) {
      const res = await serve("dress-full", `size=${size}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(await res.text()).toBe("ORIGINAL");
    }
    expect(await (await serve("dress-full")).text()).toBe("ORIGINAL");
  });

  it("prefers a variant, and the dark file in dark mode when present", async () => {
    writeFileSync(join(dir, "dress-full.png"), "ORIGINAL");
    writeFileSync(join(dir, "dress-full.small.webp"), "SMALL");
    writeFileSync(join(dir, "dress-full-dark.png"), "DARK");
    expect(await (await serve("dress-full", "size=small")).text()).toBe("SMALL");
    expect(await (await serve("dress-full", "mode=dark")).text()).toBe("DARK");
    expect((await serve("logo-512", "mode=dark")).status).toBe(404);
    writeFileSync(join(dir, "logo-512.png"), "L");
    expect(await (await serve("logo-512", "mode=dark")).text()).toBe("L");
  });

  it("is private-cacheable and never public", async () => {
    writeFileSync(join(dir, "a.png"), "x");
    const res = await serve("a");
    expect(res.headers.get("cache-control")).toMatch(/^private/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("answers 404 when the directory is unset, missing or lacks the file", async () => {
    expect((await serve("a", "", signedIn, null)).status).toBe(404);
    expect((await serve("a", "", signedIn, join(dir, "missing"))).status).toBe(404);
    mkdirSync(join(dir, "sub.png"));
    expect((await serve("sub")).status).toBe(404);
  });
});

describe("credits", () => {
  it("reads credits.txt from the directory, null otherwise", async () => {
    expect(await readCredits(null)).toBeNull();
    expect(await readCredits(dir)).toBeNull();
    writeFileSync(join(dir, "credits.txt"), "Credit line");
    expect(await readCredits(dir)).toBe("Credit line");
  });

  it("shows a generic note without credits and the text with it", () => {
    const none = renderToStaticMarkup(createElement(CreditsView, { locale: "en", credits: null }));
    expect(none).toContain(en["credits.generic_note"]);
    const some = renderToStaticMarkup(
      createElement(CreditsView, { locale: "vi", credits: "Line <b>1</b>" }),
    );
    expect(some).toContain("Line &lt;b&gt;1&lt;/b&gt;");
    expect(some).not.toContain(vi_["credits.generic_note"]);
  });

  it("lives in the More area", () => {
    expect(areaForRoute("/credits")).toBe("more");
  });

  it("keeps the credit wording out of the locale files", () => {
    for (const value of [...Object.values(en), ...Object.values(vi_)]) {
      expect(value).not.toMatch(/CC BY|NC-SA/i);
    }
    expect(Object.keys(en).sort()).toEqual(Object.keys(vi_).sort());
  });
});

describe("fallback theme without MASCOT_ART_DIR", () => {
  it("Mascot renders an original SVG fallback with initials and no image request", () => {
    const html = renderToStaticMarkup(
      createElement(Mascot, {
        artKey: "dress-full",
        size: "small",
        alt: "x",
        available: false,
        initials: "AN",
      }),
    );
    expect(html).toContain("<svg");
    expect(html).toContain("AN");
    expect(html).not.toContain("/art/");
  });

  it("Mascot with art uses a picture with a dark source", () => {
    const html = renderToStaticMarkup(
      createElement(Mascot, { artKey: "dress-full", size: "small", alt: "x", available: true }),
    );
    expect(html).toContain("<picture");
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain("/art/dress-full?size=small");
    expect(html).toContain("mode=dark");
  });

  it("the layout and credits page render with the variable unset", async () => {
    vi.stubEnv("MASCOT_ART_DIR", "");
    vi.doMock("../lib/request-context", () => ({
      getRequestContext: async () => ({
        locale: "en",
        user,
        appearance: { skin: "navy", mode: "system" },
      }),
      getRequestLocale: async () => "en",
    }));
    const { default: RootLayout } = await import("../app/layout");
    const { default: CreditsPage } = await import("../app/credits/page");
    const tree = await RootLayout({ children: await CreditsPage() });
    const html = renderToStaticMarkup(createElement("div", null, tree));
    expect(html).toContain('data-art="fallback"');
    expect(html).toContain(en["credits.generic_note"]);
    expect(html).toContain("<svg");
    vi.unstubAllEnvs();
    vi.doUnmock("../lib/request-context");
  });
});
