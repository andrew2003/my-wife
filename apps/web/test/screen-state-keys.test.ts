import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import en from "../locales/en.json";
import vi from "../locales/vi.json";

const dir = join(import.meta.dirname, "..", "components");
const catalogs = { en, vi } as Record<string, Record<string, string>>;

describe("shared state copy", () => {
  it("every stateKeys use resolves to real copy in both locales", () => {
    const missing: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".tsx"))) {
      const src = readFileSync(join(dir, file), "utf8");
      for (const m of src.matchAll(/stateKeys\(\s*"([^"]+)"(?:,\s*\{([^}]*)\})?/g)) {
        const ns = m[1] as string;
        const overrides = new Map<string, string>();
        for (const o of (m[2] ?? "").matchAll(/(\w+):\s*"([^"]+)"/g)) {
          overrides.set(o[1] as string, o[2] as string);
        }
        const kinds = ["loading", "empty", "error", "retry"].filter((k) =>
          k === "retry" ? src.includes('kind="error"') : src.includes(`kind="${k}"`),
        );
        for (const kind of kinds) {
          const key = overrides.get(kind) ?? `${ns}.${kind}`;
          for (const [locale, catalog] of Object.entries(catalogs)) {
            if (!catalog[key]) missing.push(`${file}: ${locale} ${key}`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
