import { describe, expect, it } from "vitest";
import en from "../locales/en.json";
import vi from "../locales/vi.json";

// Money is never paid into the app; the user moves their own money using the transfer list.
const BANNED: Record<"en" | "vi", RegExp[]> = {
  en: [/top[\s-]?up/i],
  // The Vietnamese verb for paying money in, and its past form.
  vi: [/nạp/i],
};

describe("banned wording", () => {
  for (const [name, catalog] of [
    ["en", en],
    ["vi", vi],
  ] as const) {
    it(`finds no banned wording in the ${name} catalog`, () => {
      const hits = Object.entries(catalog as Record<string, string>).filter(([, value]) =>
        BANNED[name].some((re) => re.test(value)),
      );
      expect(hits).toEqual([]);
    });
  }

  it("uses the transfer list and receipt wording for funding", () => {
    expect(en["funding.title"]).toMatch(/transfer list/i);
    expect(en["funding.status.funded"]).toMatch(/verified by receipt/i);
    expect(vi["funding.title"]).toMatch(/danh sách chuyển khoản/i);
    expect(vi["funding.status.funded"]).toMatch(/biên lai/i);
  });
});
