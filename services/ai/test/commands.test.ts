import { describe, expect, it } from "vitest";
import {
  commandEvents,
  type CommandSettings,
  type CustomCommandInput,
  type Locale,
} from "@my-wife/contracts";
import { buildRegistry, CommandService, parseCommand, type ControlPorts } from "../src/commands";
import { renderMessage } from "../src/i18n";

const NO_SETTINGS: CommandSettings = { overrides: [], custom: [] };
const DESC = { vi: "mô tả", en: "desc" };

const prompt = (name: string, aliases: string[] = []): CustomCommandInput => ({
  kind: "prompt",
  name,
  aliases,
  description: DESC,
  enabled: true,
  template: "do {text}",
});
const shortcut = (name: string, target: string, presetArgs: string[] = []): CustomCommandInput => ({
  kind: "shortcut",
  name,
  aliases: [],
  description: DESC,
  enabled: true,
  targetCommandId: target,
  presetArgs,
});
const mood = (name: string): CustomCommandInput => ({
  kind: "mood",
  name,
  aliases: [],
  description: DESC,
  enabled: true,
  expressionKey: "x",
});

function errorCode(settings: CommandSettings, max = 20): string | null {
  try {
    buildRegistry(settings, max);
  } catch (e) {
    return (e as { code: string }).code;
  }
  return null;
}

describe("parseCommand", () => {
  it("parses name and arguments, lowercases, strips the bot suffix", () => {
    expect(parseCommand("/Lang en")).toEqual({ name: "lang", args: ["en"] });
    expect(parseCommand("  /quiet   until  22:30 ")).toEqual({
      name: "quiet",
      args: ["until", "22:30"],
    });
    expect(parseCommand("/help@my_wife_bot")).toEqual({ name: "help", args: [] });
  });
  it("returns null for text that is not a command", () => {
    for (const text of ["hello", "", "/", "/ help", "/bad-name", "see /help"])
      expect(parseCommand(text)).toBeNull();
  });
});

describe("registry", () => {
  it("resolves a name and a Vietnamese alias to the same command", () => {
    const r = buildRegistry(NO_SETTINGS, 20);
    expect(r.resolve("help")?.def.id).toBe("help");
    expect(r.resolve("tro_giup")?.def.id).toBe("help");
    expect(r.resolve("nope")).toBeUndefined();
  });
  it("honours overrides: rename, alias, disable", () => {
    const r = buildRegistry(
      {
        overrides: [{ commandId: "help", name: "giup", aliases: ["h"], enabled: false }],
        custom: [],
      },
      20,
    );
    expect(r.resolve("h")?.def.enabled).toBe(false);
    expect(r.resolve("giup")?.def.id).toBe("help");
    expect(r.resolve("help")).toBeUndefined();
  });
  it("rejects duplicate names and aliases", () => {
    expect(errorCode({ overrides: [], custom: [prompt("help")] })).toBe("duplicate_name");
    expect(errorCode({ overrides: [], custom: [prompt("a"), prompt("a")] })).toBe("duplicate_name");
    expect(errorCode({ overrides: [], custom: [prompt("a", ["tro_giup"])] })).toBe(
      "duplicate_name",
    );
    expect(errorCode({ overrides: [{ commandId: "help", aliases: ["status"] }], custom: [] })).toBe(
      "duplicate_name",
    );
  });
  it("rejects shortcut loops and unknown targets", () => {
    expect(errorCode({ overrides: [], custom: [shortcut("a", "custom:a")] })).toBe("shortcut_loop");
    expect(
      errorCode({ overrides: [], custom: [shortcut("a", "custom:b"), shortcut("b", "custom:a")] }),
    ).toBe("shortcut_loop");
    expect(errorCode({ overrides: [], custom: [shortcut("a", "ghost")] })).toBe("unknown_target");
    expect(
      errorCode({ overrides: [], custom: [shortcut("a", "custom:b"), shortcut("b", "help")] }),
    ).toBeNull();
  });
  it("respects the maximum number of custom commands", () => {
    const custom = [prompt("a"), prompt("b"), prompt("c")];
    expect(errorCode({ overrides: [], custom }, 3)).toBeNull();
    expect(errorCode({ overrides: [], custom }, 2)).toBe("too_many_custom");
  });
});

function setup(opts: { settings?: CommandSettings; max?: number } = {}) {
  const calls: unknown[][] = [];
  const events: { name: string; payload: unknown }[] = [];
  const rec =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  const ports = {
    setLocale: rec("setLocale"),
    setStrictness: rec("setStrictness"),
    setQuiet: rec("setQuiet"),
    resetConversation: rec("new"),
    stop: rec("stop"),
    skins: async () => ({ current: "classic", available: ["classic", "night"] }),
    setSkin: rec("setSkin"),
    currentModel: async () => "model-a",
    usage: async () => ({ usedToday: 120, cap: 200000, quota: "80%" }),
    status: async () => ({
      cycleSequence: 4,
      weekIndex: 2,
      tasksDone: 3,
      tasksTotal: 5,
      faultPoints: 1,
      syncLinks: [{ link: "sheet", state: "ok" }],
      degraded: false,
    }),
  } satisfies ControlPorts;
  const service = new CommandService({
    ports,
    loadCommandSettings: async () => opts.settings ?? NO_SETTINGS,
    readSettings: async () => ({ "chat.max_custom_commands": opts.max ?? 20 }),
    publish: async (e) => {
      events.push(e);
    },
  });
  const send = (text: string, locale: Locale = "en") =>
    service.handle({ channel: "telegram", userId: "u1", text, locale });
  const text = (
    r: { reply: { key: string; params: Record<string, string | number | boolean> } },
    l: Locale = "en",
  ) => renderMessage(r.reply, l);
  return { send, calls, events, text };
}

describe("command service", () => {
  it("ignores text that is not a command", async () => {
    expect(await setup().send("hello")).toBeNull();
  });
  it("resolves an alias", async () => {
    const t = setup();
    const r = await t.send("/tro_giup");
    expect(r?.status).toBe("ok");
    expect(t.text(r!)).toContain("/help");
  });
  it("refuses a disabled command as configured and publishes command.refused", async () => {
    const t = setup({
      settings: { overrides: [{ commandId: "new", enabled: false }], custom: [] },
    });
    const r = await t.send("/new");
    expect(r?.status).toBe("disabled");
    expect(t.calls).toEqual([]);
    expect(t.events).toHaveLength(1);
    expect(commandEvents["command.refused"].parse(t.events[0]!.payload)).toMatchObject({
      reason: "disabled",
    });
  });
  it("answers unknown commands", async () => {
    expect((await setup().send("/zzz"))?.status).toBe("unknown");
  });
  it("/lang en changes the profile language and replies in it", async () => {
    const t = setup();
    const r = await t.send("/lang en", "vi");
    expect(r?.status).toBe("ok");
    expect(t.calls).toEqual([["setLocale", "u1", "en"]]);
    expect(r?.reply.key).toBe("commands.lang.changed");
    expect((await t.send("/lang fr"))?.status).toBe("refused");
  });
  it("/help lists enabled commands with descriptions in the locale", async () => {
    const t = setup({
      settings: { overrides: [{ commandId: "stop", enabled: false }], custom: [] },
    });
    const vi = t.text((await t.send("/help", "vi"))!, "vi");
    expect(vi).toContain("/help");
    expect(vi).not.toContain("/stop");
  });
  it("/status and /usage report facts from code", async () => {
    const t = setup();
    const s = t.text((await t.send("/status"))!);
    expect(s).toContain("3/5");
    expect(s).toContain("sheet");
    const u = t.text((await t.send("/usage"))!);
    expect(u).toContain("120");
    expect(u).toContain("200000");
    expect(u).toContain("80%");
  });
  it("/new and /stop act", async () => {
    const t = setup();
    expect((await t.send("/new"))?.status).toBe("ok");
    expect((await t.send("/stop"))?.status).toBe("ok");
    expect(t.calls).toEqual([
      ["new", "u1"],
      ["stop", "u1"],
    ]);
  });
  it("/strict validates 1-5", async () => {
    const t = setup();
    expect((await t.send("/strict 4"))?.status).toBe("ok");
    expect(t.calls).toEqual([["setStrictness", "u1", 4]]);
    for (const bad of ["/strict", "/strict 0", "/strict 6", "/strict x", "/strict 2.5"])
      expect((await t.send(bad))?.status).toBe("refused");
  });
  it("/quiet sets, clears and validates", async () => {
    const t = setup();
    await t.send("/quiet until 22:30");
    await t.send("/quiet off");
    expect(t.calls).toEqual([
      ["setQuiet", "u1", "22:30"],
      ["setQuiet", "u1", null],
    ]);
    expect((await t.send("/quiet until 25:00"))?.status).toBe("refused");
    expect((await t.send("/quiet"))?.status).toBe("refused");
  });
  it("/skin lists or sets a known skin", async () => {
    const t = setup();
    expect(t.text((await t.send("/skin"))!)).toContain("night");
    expect((await t.send("/skin night"))?.status).toBe("ok");
    expect((await t.send("/skin nope"))?.status).toBe("refused");
    expect(t.calls).toEqual([["setSkin", "u1", "night"]]);
  });
  it("/model shows the current model, a switch needs confirmation", async () => {
    const t = setup();
    const show = await t.send("/model");
    expect(show?.status).toBe("ok");
    expect(t.text(show!)).toContain("model-a");
    const sw = await t.send("/model model-b");
    expect(sw?.status).toBe("needs_confirmation");
    expect(sw?.reply.params).toMatchObject({ model: "model-b" });
  });
  it("a shortcut runs its target with preset arguments", async () => {
    const t = setup({
      settings: { overrides: [], custom: [shortcut("calm", "strict", ["1"])] },
    });
    expect((await t.send("/calm"))?.status).toBe("ok");
    expect(t.calls).toEqual([["setStrictness", "u1", 1]]);
  });
  it("publishes command.executed without message text", async () => {
    const t = setup();
    await t.send("/new");
    const payload = commandEvents["command.executed"].parse(t.events[0]!.payload);
    expect(payload).toEqual({ commandId: "new", channel: "telegram", status: "ok", ai: false });
  });
  it("an invalid registry refuses every command", async () => {
    const t = setup({ max: 1, settings: { overrides: [], custom: [mood("a"), mood("b")] } });
    expect((await t.send("/help"))?.status).toBe("refused");
  });
});
