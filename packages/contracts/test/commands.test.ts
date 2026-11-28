import { describe, expect, it } from "vitest";
import {
  COMMAND_NAME_PATTERN,
  CommandDefinitionSchema,
  CommandInvocationSchema,
  CommandMenuEntrySchema,
  CommandResultSchema,
  CommandSettingsSchema,
  CustomCommandInputSchema,
  EVENT_REGISTRY,
  MoodTagSchema,
  SETTINGS,
  validateSettingValue,
  parseEvent,
} from "../src/index";

const builtin = {
  id: "help",
  kind: "builtin",
  name: "help",
  aliases: ["tro_giup"],
  descriptionKey: "commands.help.description",
  enabled: true,
  ai: false,
  builtin: true,
  args: [],
};

describe("command names", () => {
  it.each([
    ["spend", true],
    ["tro_giup", true],
    ["a".repeat(32), true],
    ["a".repeat(33), false],
    ["", false],
    ["Help", false],
    ["two words", false],
    ["/help", false],
    ["đi", false],
  ])("%s -> %s", (name, ok) => {
    expect(COMMAND_NAME_PATTERN.test(name)).toBe(ok);
  });
});

describe("CommandDefinition", () => {
  it("parses a built-in with a description key", () => {
    expect(CommandDefinitionSchema.safeParse(builtin).success).toBe(true);
  });
  it("parses a custom command with per-locale description text", () => {
    const r = CommandDefinitionSchema.safeParse({
      ...builtin,
      id: "c1",
      kind: "prompt",
      name: "recipe",
      aliases: [],
      descriptionKey: undefined,
      description: { vi: "Goi y mon an", en: "Suggest a meal" },
      builtin: false,
      ai: true,
    });
    expect(r.success).toBe(true);
  });
  it("requires a description key or text", () => {
    const { descriptionKey: _k, ...rest } = builtin;
    expect(CommandDefinitionSchema.safeParse(rest).success).toBe(false);
  });
  it("rejects a bad name or alias", () => {
    expect(CommandDefinitionSchema.safeParse({ ...builtin, name: "Bad Name" }).success).toBe(false);
    expect(CommandDefinitionSchema.safeParse({ ...builtin, aliases: ["ok", "NO"] }).success).toBe(false);
  });
  it("rejects duplicate names and aliases within one command", () => {
    expect(CommandDefinitionSchema.safeParse({ ...builtin, aliases: ["help"] }).success).toBe(false);
    expect(CommandDefinitionSchema.safeParse({ ...builtin, aliases: ["a", "a"] }).success).toBe(false);
  });
  it("rejects an unknown kind", () => {
    expect(CommandDefinitionSchema.safeParse({ ...builtin, kind: "script" }).success).toBe(false);
  });
});

describe("CustomCommandInput", () => {
  it("parses a prompt command with the {text} placeholder", () => {
    const r = CustomCommandInputSchema.safeParse({
      kind: "prompt",
      name: "recipe",
      aliases: ["cook"],
      description: { vi: "Mon an", en: "Meal" },
      template: "Suggest a meal for: {text}",
    });
    expect(r.success).toBe(true);
  });
  it("rejects a prompt template without {text}", () => {
    const r = CustomCommandInputSchema.safeParse({
      kind: "prompt",
      name: "recipe",
      description: { vi: "a", en: "b" },
      template: "no placeholder",
    });
    expect(r.success).toBe(false);
  });
  it("parses a mood command with an expression key", () => {
    const r = CustomCommandInputSchema.safeParse({
      kind: "mood",
      name: "proud",
      description: { vi: "a", en: "b" },
      expressionKey: "proud",
    });
    expect(r.success).toBe(true);
  });
  it("parses a shortcut to an existing command with preset arguments", () => {
    const r = CustomCommandInputSchema.safeParse({
      kind: "shortcut",
      name: "coffee",
      description: { vi: "a", en: "b" },
      targetCommandId: "spend",
      presetArgs: ["30000", "coffee"],
    });
    expect(r.success).toBe(true);
  });
  it("rejects kind-mismatched fields", () => {
    const r = CustomCommandInputSchema.safeParse({
      kind: "shortcut",
      name: "coffee",
      description: { vi: "a", en: "b" },
      template: "{text}",
    });
    expect(r.success).toBe(false);
  });
  it("rejects a builtin kind as custom input", () => {
    expect(
      CustomCommandInputSchema.safeParse({ kind: "builtin", name: "x", description: { vi: "a", en: "b" } }).success,
    ).toBe(false);
  });
});

describe("CommandInvocation and CommandResult", () => {
  it("parses an invocation", () => {
    const r = CommandInvocationSchema.safeParse({
      channel: "telegram",
      userId: "u1",
      rawText: "/spend 30000 coffee",
      resolvedCommandId: "spend",
      args: ["30000", "coffee"],
      locale: "vi",
    });
    expect(r.success).toBe(true);
  });
  it("allows an unresolved invocation and the in-app web channel", () => {
    const r = CommandInvocationSchema.safeParse({
      channel: "web",
      userId: "u1",
      rawText: "/nope",
      args: [],
      locale: "en",
    });
    expect(r.success).toBe(true);
  });
  it("rejects raw text that is not a command", () => {
    expect(
      CommandInvocationSchema.safeParse({ channel: "web", userId: "u", rawText: "hello", args: [], locale: "en" })
        .success,
    ).toBe(false);
  });
  it.each(["ok", "refused", "needs_confirmation", "unknown", "disabled"])("accepts status %s", (status) => {
    expect(CommandResultSchema.safeParse({ status, reply: { key: "commands.reply", params: {} } }).success).toBe(true);
  });
  it("rejects an unknown status", () => {
    expect(CommandResultSchema.safeParse({ status: "failed", reply: { key: "x", params: {} } }).success).toBe(false);
  });
});

describe("MoodTag", () => {
  it("has exactly the five tags", () => {
    expect(MoodTagSchema.options).toEqual(["happy", "sad", "tired", "stressed", "angry"]);
  });
});

describe("settings and menu entries", () => {
  it("parses per-user command settings", () => {
    const r = CommandSettingsSchema.safeParse({
      overrides: [{ commandId: "help", enabled: false, name: "giup", aliases: [], description: { vi: "a", en: "b" } }],
      custom: [],
    });
    expect(r.success).toBe(true);
  });
  it("rejects an override that renames to an invalid name", () => {
    expect(CommandSettingsSchema.safeParse({ overrides: [{ commandId: "help", name: "BAD" }], custom: [] }).success).toBe(
      false,
    );
  });
  it("parses a menu entry and limits the description to the channel maximum", () => {
    expect(CommandMenuEntrySchema.safeParse({ command: "help", description: "Show help" }).success).toBe(true);
    expect(CommandMenuEntrySchema.safeParse({ command: "help", description: "x".repeat(257) }).success).toBe(false);
    expect(CommandMenuEntrySchema.safeParse({ command: "help", description: "" }).success).toBe(false);
  });
  it("registers a setting for the custom command limit", () => {
    expect(SETTINGS["chat.max_custom_commands"].default).toBe(20);
  });
  it("registers and validates the command overrides setting", () => {
    expect(SETTINGS["commands.overrides"].default).toEqual([]);
    const ok = [{ commandId: "help", enabled: false }, { commandId: "task", name: "todo", aliases: ["viec"] }];
    expect(validateSettingValue("commands.overrides", ok).success).toBe(true);
    expect(validateSettingValue("commands.overrides", []).success).toBe(true);
    expect(validateSettingValue("commands.overrides", {}).success).toBe(false);
    expect(validateSettingValue("commands.overrides", [{ enabled: false }]).success).toBe(false);
    expect(validateSettingValue("commands.overrides", [{ commandId: "help", name: "Bad Name" }]).success).toBe(false);
  });
});

describe("command events", () => {
  const base = { id: "e1", occurredAt: "2026-11-28T00:00:00Z", userId: "u1", schemaVersion: 1 };
  it("registers both events under notify", () => {
    expect(EVENT_REGISTRY["command.executed"].publisher).toBe("notify");
    expect(EVENT_REGISTRY["command.refused"].publisher).toBe("notify");
  });
  it("parses command.executed", () => {
    const r = parseEvent({
      ...base,
      type: "command.executed",
      payload: { commandId: "spend", channel: "telegram", status: "ok", ai: false },
    });
    expect(r.success).toBe(true);
  });
  it("parses command.refused", () => {
    const r = parseEvent({
      ...base,
      type: "command.refused",
      payload: { commandId: "forget", channel: "web", reason: "disabled" },
    });
    expect(r.success).toBe(true);
  });
  it("never carries message text", () => {
    const r = parseEvent({
      ...base,
      type: "command.executed",
      payload: { commandId: "spend", channel: "web", status: "ok", ai: false, rawText: "/spend 1" },
    });
    expect(r.success).toBe(false);
  });
});
