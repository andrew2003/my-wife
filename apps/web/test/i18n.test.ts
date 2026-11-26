import { describe, expect, it } from "vitest";
import en from "../locales/en.json";
import vi from "../locales/vi.json";
import { defaultLocale, translate } from "../lib/i18n";

describe("locale files", () => {
  it("vi and en define exactly the same keys", () => {
    expect(Object.keys(vi).sort()).toEqual(Object.keys(en).sort());
  });

  it("no value is empty", () => {
    for (const v of [...Object.values(vi), ...Object.values(en)]) expect(v.trim()).not.toBe("");
  });
});

describe("i18n", () => {
  it("defaults to Vietnamese when UI_LANGUAGE is unset or invalid", () => {
    expect(defaultLocale(undefined)).toBe("vi");
    expect(defaultLocale("fr")).toBe("vi");
  });

  it("uses UI_LANGUAGE when valid", () => {
    expect(defaultLocale("en")).toBe("en");
  });

  it("translates with parameters", () => {
    expect(translate("en", "greeting", { name: "An" })).toBe("Hello, An");
  });

  it("falls back to the key when missing", () => {
    expect(translate("en", "does.not.exist")).toBe("does.not.exist");
  });
});
