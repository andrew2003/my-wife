import { describe, expect, it } from "vitest";
import { ConsentKindSchema } from "@my-wife/contracts";
import en from "../locales/en.json";
import vi from "../locales/vi.json";

describe("consent locale keys", () => {
  for (const [name, catalog] of [
    ["en", en],
    ["vi", vi],
  ] as const) {
    for (const kind of ConsentKindSchema.options) {
      it(`${name} has texts for ${kind}`, () => {
        const keys = catalog as Record<string, string>;
        expect(keys[`privacy.consent.${kind}`]).toBeTruthy();
        expect(keys[`privacy.consent.${kind}.help`]).toBeTruthy();
      });
    }
  }
});
