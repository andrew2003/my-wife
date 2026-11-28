import { describe, expect, it } from "vitest";
import type { CommandSettings, CustomCommandInput, Locale } from "@my-wife/contracts";
import { ChatService } from "../src/chat/chat-service";
import { FakeLlmProvider } from "../src/llm";
import {
  CommandService,
  CustomCommandManager,
  type CommandServiceDeps,
  type ControlPorts,
} from "../src/commands";
import { renderMessage } from "../src/i18n";

const DESC = { vi: "mo ta", en: "Explain things simply" };
const prompt = (name: string, template = "Explain: {text}"): CustomCommandInput => ({
  kind: "prompt",
  name,
  aliases: [],
  description: DESC,
  enabled: true,
  template,
});
const mood = (name: string): CustomCommandInput => ({
  kind: "mood",
  name,
  aliases: [],
  description: DESC,
  enabled: true,
  expressionKey: "smile",
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

function manager(max = 20) {
  let settings: CommandSettings = { overrides: [], custom: [] };
  const m = new CustomCommandManager({
    load: async () => settings,
    save: async (_u, s) => {
      settings = s;
    },
    maxCustom: async () => max,
  });
  return { m, get: () => settings };
}

describe("custom command manager", () => {
  it("creates prompt, mood and shortcut commands into the registry", async () => {
    const { m, get } = manager();
    await m.create("u1", prompt("eli5"));
    await m.create("u1", mood("cheer"));
    await m.create("u1", shortcut("calm", "strict", ["1"]));
    expect(get().custom.map((c) => c.name)).toEqual(["eli5", "cheer", "calm"]);
    const reg = await m.registry("u1");
    expect(reg.resolve("eli5")?.def.kind).toBe("prompt");
    expect(reg.resolve("cheer")?.custom?.kind).toBe("mood");
    expect(reg.resolve("calm")?.custom?.kind).toBe("shortcut");
  });
  it("rejects duplicates, loops, unknown targets and the limit without saving", async () => {
    const { m, get } = manager(2);
    await m.create("u1", prompt("a"));
    await expect(m.create("u1", prompt("a"))).rejects.toMatchObject({ code: "duplicate_name" });
    await expect(m.create("u1", prompt("help"))).rejects.toMatchObject({ code: "duplicate_name" });
    await expect(m.create("u1", shortcut("s", "custom:s"))).rejects.toMatchObject({
      code: "shortcut_loop",
    });
    await expect(m.create("u1", shortcut("s", "ghost"))).rejects.toMatchObject({
      code: "unknown_target",
    });
    await m.create("u1", prompt("b"));
    await expect(m.create("u1", prompt("c"))).rejects.toMatchObject({ code: "too_many_custom" });
    expect(get().custom).toHaveLength(2);
  });
  it("try validates without saving", async () => {
    const { m, get } = manager();
    await m.tryOut("u1", prompt("draft"));
    expect(get().custom).toEqual([]);
    await expect(m.tryOut("u1", prompt("help"))).rejects.toMatchObject({ code: "duplicate_name" });
  });
  it("deletes a command and refuses when a shortcut still targets it", async () => {
    const { m, get } = manager();
    await m.create("u1", prompt("a"));
    await m.create("u1", shortcut("s", "custom:a"));
    await expect(m.remove("u1", "a")).rejects.toMatchObject({ code: "unknown_target" });
    await m.remove("u1", "s");
    await m.remove("u1", "a");
    expect(get().custom).toEqual([]);
    expect((await m.registry("u1")).resolve("a")).toBeUndefined();
    await expect(m.remove("u1", "a")).rejects.toMatchObject({ code: "unknown_command" });
  });
});

function setup(custom: CustomCommandInput[]) {
  const provider = new FakeLlmProvider({ reply: () => ({ text: "model answer", toolCalls: [] }) });
  const chat = new ChatService({ provider, publish: async () => {} });
  const calls: unknown[][] = [];
  const noop = async (...a: unknown[]) => {
    calls.push(a);
  };
  const ports = {
    setLocale: noop,
    setStrictness: noop,
    setQuiet: noop,
    resetConversation: noop,
    stop: noop,
    skins: async () => ({ current: "a", available: ["a"] }),
    setSkin: noop,
    currentModel: async () => "m",
    usage: async () => ({ usedToday: 0, cap: 1 }),
    status: async () => ({
      cycleSequence: 1,
      weekIndex: 1,
      tasksDone: 0,
      tasksTotal: 0,
      faultPoints: 0,
      syncLinks: [],
      degraded: false,
    }),
  } satisfies ControlPorts;
  const deps: CommandServiceDeps = {
    ports,
    loadCommandSettings: async () => ({ overrides: [], custom }),
    readSettings: async () => ({}),
    publish: async () => {},
    runPrompt: (userId, req) =>
      chat.handleCommandPrompt(req.command, req.text, req.locale, userId).then((r) => r.reply),
  };
  const service = new CommandService(deps);
  const send = (text: string, locale: Locale = "en") =>
    service.handle({ channel: "telegram", userId: "u1", text, locale });
  return { send, provider, calls };
}

describe("custom command execution", () => {
  it("a prompt command sends its description and {text} to the model context", async () => {
    const t = setup([prompt("eli5")]);
    const r = await t.send("/eli5 black holes");
    expect(r?.status).toBe("ok");
    expect(r?.reply.params).toMatchObject({ text: "model answer" });
    const req = t.provider.requests[0]!;
    expect(req.system).toContain("Explain things simply");
    expect(req.system).toContain("/eli5");
    expect(req.userText).toBe("Explain: black holes");
  });
  it("uses the description in the user's locale", async () => {
    const t = setup([prompt("eli5")]);
    await t.send("/eli5 x", "vi");
    expect(t.provider.requests[0]!.system).toContain("mo ta");
  });
  it("a prompt command without text is refused and the model is not called", async () => {
    const t = setup([prompt("eli5")]);
    expect((await t.send("/eli5"))?.status).toBe("refused");
    expect(t.provider.requests).toEqual([]);
  });
  it("a mood command replies with its expression key", async () => {
    const t = setup([mood("cheer")]);
    const r = await t.send("/cheer");
    expect(r?.status).toBe("ok");
    expect(r?.reply.params).toMatchObject({ expression: "smile" });
    expect(renderMessage(r!.reply, "en")).toContain("smile");
  });
  it("a shortcut to a prompt command runs that prompt with preset arguments", async () => {
    const t = setup([prompt("eli5"), shortcut("bh", "custom:eli5", ["black", "holes"])]);
    await t.send("/bh");
    expect(t.provider.requests[0]!.userText).toBe("Explain: black holes");
  });
});
