import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateTokensCss } from "../lib/theme";

const root = join(import.meta.dirname, "..");
const fontsCss = readFileSync(join(root, "app", "fonts.css"), "utf8");

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules") return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const CDN_HOSTS = [
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "use.typekit.net",
  "use.fontawesome.com",
  "cdn.jsdelivr.net",
  "cdnjs.cloudflare.com",
  "unpkg.com",
  "fonts.bunny.net",
];

function namesCdn(files: string[]): string[] {
  return files.filter((f) => {
    const text = readFileSync(f, "utf8");
    return CDN_HOSTS.some((h) => text.includes(h));
  });
}

describe("fonts are self-hosted", () => {
  it("source files name no font CDN host", () => {
    const files = ["app", "components", "lib"]
      .flatMap((d) => walk(join(root, d)))
      .filter((f) => /\.(tsx?|css|mjs)$/.test(f));
    expect(namesCdn(files)).toEqual([]);
  });

  it("the build output, when present, names no font CDN host", () => {
    const out = walk(join(root, ".next", "static")).filter((f) => /\.(css|js)$/.test(f));
    expect(namesCdn(out)).toEqual([]);
  });

  it("every font-face points at a local file and swaps", () => {
    const faces = fontsCss.match(/@font-face\s*{[^}]*}/g) ?? [];
    expect(faces.length).toBe(6);
    for (const face of faces) {
      expect(face).toContain("font-display: swap");
      const url = /url\(([^)]+)\)/.exec(face)?.[1] ?? "";
      expect(url).not.toMatch(/^["']?(https?:)?\/\//);
      expect(existsSync(join(root, "app", url.replace(/["']/g, "")))).toBe(true);
    }
  });

  it("covers Latin and Vietnamese for UI 400 and 600 and one title weight", () => {
    for (const subset of ["latin", "vietnamese"]) {
      expect(fontsCss).toContain(`be-vietnam-pro-${subset}-400`);
      expect(fontsCss).toContain(`be-vietnam-pro-${subset}-600`);
      expect(fontsCss).toContain(`playfair-display-${subset}-600`);
    }
    expect(fontsCss).toContain("U+1EA0-1EF9");
  });

  it("licence texts sit beside the font files", () => {
    expect(existsSync(join(root, "app", "fonts", "LICENSE-be-vietnam-pro.txt"))).toBe(true);
    expect(existsSync(join(root, "app", "fonts", "LICENSE-playfair-display.txt"))).toBe(true);
  });

  it("tokens name the families with a system fallback and the layout loads the css", () => {
    const css = generateTokensCss();
    expect(css).toContain('--mw-font-ui: "Be Vietnam Pro", system-ui, sans-serif');
    expect(css).toContain('--mw-font-title: "Playfair Display", Georgia, serif');
    const layout = readFileSync(join(root, "app", "layout.tsx"), "utf8");
    expect(layout).toContain("./fonts.css");
    expect(layout).toContain("./ui.css");
  });
});
