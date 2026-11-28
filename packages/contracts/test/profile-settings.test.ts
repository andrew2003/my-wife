import { describe, expect, it } from "vitest";
import {
  ListCustomCommandsResponseSchema,
  SETTINGS,
  validateSettingValue,
} from "../src/index";

describe("appearance and persona settings", () => {
  it.each([
    ["appearance.skin", "hanfu", true],
    ["appearance.skin", "pink", false],
    ["appearance.mode", "system", true],
    ["appearance.mode", "auto", false],
    ["appearance.expression_set", "blue_face", true],
    ["appearance.expression_set", "other", false],
    ["appearance.expression_map", SETTINGS["appearance.expression_map"].default, true],
    ["appearance.expression_map", { greeting: "nope" }, false],
    ["persona.address_user", { vi: [{ text: "anh", enabled: true }], en: [] }, true],
    ["persona.address_user", { vi: [{ text: " ", enabled: true }], en: [] }, false],
    ["persona.wife_label", SETTINGS["persona.wife_label"].default, true],
  ])("%s accepts or rejects %j", (key, value, ok) => {
    expect(validateSettingValue(key, value).success).toBe(ok);
  });

  it("parses the custom command list response", () => {
    expect(
      ListCustomCommandsResponseSchema.safeParse({ ok: true, data: { custom: [] } }).success,
    ).toBe(true);
    expect(ListCustomCommandsResponseSchema.safeParse({ ok: true, data: {} }).success).toBe(false);
  });
});
