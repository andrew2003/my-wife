import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MODES,
  SKINS,
  contrastRatio,
  generateTokensCss,
  parseMode,
  parseSkin,
  requiredPairs,
  themeColors,
} from "../lib/theme";

describe("contrast helper", () => {
  it("matches the WCAG reference values", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 1);
    expect(contrastRatio("#777777", "#FFFFFF")).toBeCloseTo(4.48, 1);
    expect(contrastRatio("#FFFFFF", "#FFFFFF")).toBeCloseTo(1, 5);
  });
});

describe("every skin and mode meets WCAG AA", () => {
  const combos = SKINS.flatMap((skin) =>
    (["light", "dark"] as const).map((mode) => [skin, mode] as const),
  );
  it("covers 4 skins x 2 modes", () => expect(combos).toHaveLength(8));
  for (const [skin, mode] of combos) {
    it(`${skin} ${mode}: all text and control pairs`, () => {
      const pairs = requiredPairs(skin, mode);
      expect(pairs.length).toBeGreaterThan(10);
      for (const pair of pairs) {
        expect(
          contrastRatio(pair.foreground, pair.background),
          `${skin}/${mode} ${pair.name}`,
        ).toBeGreaterThanOrEqual(pair.minimum);
      }
    });
  }
});

describe("appearance cookies", () => {
  it("falls back to navy and system on missing or invalid values", () => {
    expect(parseSkin(undefined)).toBe("navy");
    expect(parseSkin("nope")).toBe("navy");
    expect(parseSkin("hanfu")).toBe("hanfu");
    expect(parseMode(undefined)).toBe("system");
    expect(parseMode("x")).toBe("system");
    expect(parseMode("dark")).toBe("dark");
    expect(MODES).toEqual(["light", "dark", "system"]);
  });
  it("has a light and a dark theme color", () => {
    const colors = themeColors("navy");
    expect(colors.light).toMatch(/^#/);
    expect(colors.dark).toMatch(/^#/);
  });
});

describe("generated stylesheet", () => {
  const css = generateTokensCss();
  it("defines skin and mode selectors and the system media query", () => {
    for (const skin of SKINS) {
      expect(css).toContain(`[data-skin="${skin}"]`);
      expect(css).toContain(`[data-skin="${skin}"][data-mode="dark"]`);
    }
    expect(css).toContain("prefers-color-scheme: dark");
    expect(css).toContain("prefers-reduced-motion");
    expect(css).toContain("--mw-color-primary");
  });
});

describe("committed stylesheet", () => {
  it("matches the generator output (run the tokens script after editing the table)", () => {
    const file = join(import.meta.dirname, "..", "app", "tokens.css");
    expect(readFileSync(file, "utf8")).toBe(generateTokensCss());
  });
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === ".next") return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

describe("hex colors live only in the token source", () => {
  it("finds none elsewhere in app, components or lib", () => {
    const root = join(import.meta.dirname, "..");
    const files = ["app", "components", "lib"]
      .flatMap((dir) => walk(join(root, dir)))
      .filter(
        (f) =>
          /\.(ts|tsx|css|mjs)$/.test(f) &&
          !f.endsWith(join("lib", "theme.ts")) &&
          !f.endsWith("tokens.css"),
      );
    const offenders = files.filter((f) => /#[0-9a-fA-F]{3,8}\b/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
