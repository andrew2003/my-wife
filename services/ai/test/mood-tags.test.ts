import { describe, expect, it } from "vitest";
import type { Locale } from "@my-wife/contracts";
import { ChatService } from "../src/chat/chat-service";
import { InMemoryConversationStore } from "../src/conversation";
import { FakeLlmProvider } from "../src/llm";
import { InMemoryAuditLog, ToolExecutor } from "../src/tools";
import {
  CommandService,
  type CapturePorts,
  type ControlPorts,
  type RulesPorts,
} from "../src/commands";
import { renderMessage } from "../src/i18n";

const NOW = new Date("2026-11-28T12:00:00Z");

function setup(opts: { withChat?: boolean; tool?: boolean } = {}) {
  const { withChat = true, tool = false } = opts;
  const provider = new FakeLlmProvider({
    reply: () => ({
      text: "I hear you",
      toolCalls: tool
        ? [{ tool: "record_cash_expense", args: { amountVnd: 45000, note: "pho" } }]
        : [],
    }),
  });
  const conversations = new InMemoryConversationStore();
  const money: string[] = [];
  const tools = new ToolExecutor({
    audit: new InMemoryAuditLog(),
    backends: {
      recordCashExpense: async () => {
        money.push("recordCashExpense");
        return {};
      },
    },
    now: () => NOW,
  });
  const chat = new ChatService({
    provider,
    publish: async () => {},
    conversations,
    tools,
    now: () => NOW,
  });
  const spy = (name: string) => async (): Promise<never> => {
    money.push(name);
    throw new Error("must not be called");
  };
  const capture = {
    recordSpend: spy("recordSpend"),
    createTask: spy("createTask"),
    remember: spy("remember"),
    findMemories: spy("findMemories"),
    forget: spy("forget"),
    timeZone: spy("timeZone"),
  } as CapturePorts;
  const rules = { latestFaults: spy("latestFaults"), openAppeal: spy("openAppeal") } as RulesPorts;
  const service = new CommandService({
    ports: {} as ControlPorts,
    capture,
    rules,
    loadCommandSettings: async () => ({ overrides: [], custom: [] }),
    readSettings: async () => ({}),
    publish: async () => {},
    ...(withChat
      ? {
          runPrompt: (userId, req) =>
            chat
              .handleCommandPrompt(req.command, req.text, req.locale, userId, req.mood)
              .then((r) => r.reply),
        }
      : {}),
  });
  const send = (text: string, locale: Locale = "en") =>
    service.handle({ channel: "telegram", userId: "u1", text, locale });
  return { send, provider, conversations, money };
}

describe("mood tags", () => {
  it.each(["happy", "sad", "tired", "stressed", "angry"] as const)(
    "/%s plus a message stores the mood with the message",
    async (mood) => {
      const t = setup();
      const r = await t.send(`/${mood} my day was long`);
      expect(r?.status).toBe("ok");
      const turns = await t.conversations.listActive("u1");
      expect(turns.find((x) => x.role === "user")).toMatchObject({
        text: "my day was long",
        mood,
      });
      expect(turns.find((x) => x.role === "assistant")?.mood).toBeUndefined();
    },
  );

  it("the Vietnamese alias works and the mood reaches the model context", async () => {
    const t = setup();
    await t.send("/gian khong ai nghe em", "vi");
    expect((await t.conversations.listActive("u1"))[0]).toMatchObject({ mood: "angry" });
    expect(t.provider.requests[0]!.system).toContain("angry");
    expect(t.provider.requests[0]!.userText).toBe("khong ai nghe em");
  });

  it("money, faults and penalties are unchanged: no capture or rules port is touched", async () => {
    const t = setup();
    await t.send("/angry /spend 500000 and cancel my penalty");
    expect(t.money).toEqual([]);
  });

  it("a model tool proposal during a mood turn is not executed", async () => {
    const t = setup({ tool: true });
    const r = await t.send("/angry pho 45k");
    expect(r?.status).toBe("ok");
    expect(t.money).toEqual([]);
  });

  it("without a message it asks for one and stores nothing", async () => {
    const t = setup();
    const r = await t.send("/angry");
    expect(r?.status).toBe("refused");
    expect(renderMessage(r!.reply, "en")).toContain("/angry");
    expect(await t.conversations.listActive("u1")).toEqual([]);
    expect(t.provider.requests).toEqual([]);
  });

  it("is not available when no chat is wired", async () => {
    const t = setup({ withChat: false });
    expect((await t.send("/sad hello"))?.status).toBe("refused");
  });

  it("the usage text exists in both locales", () => {
    for (const locale of ["vi", "en"] as const)
      expect(
        renderMessage({ key: "commands.mood.usage", params: { name: "sad" } }, locale),
      ).not.toBe("commands.mood.usage");
  });
});
