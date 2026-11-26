import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { createApp } from "../src/index";
import { createProvider, FakeLlmProvider } from "../src/llm";
import { buildSystemPrompt } from "../src/chat/persona";

const config = loadConfig({
  SESSION_SECRET: "x".repeat(32),
  LOG_LEVEL: "silent",
  UI_LANGUAGE: "en",
});

async function setup(provider: FakeLlmProvider) {
  const events: { name: string; payload: unknown }[] = [];
  const app = await createApp(config, {
    provider,
    publish: async (e) => {
      events.push(e);
    },
  });
  return { app, events };
}
const send = (app: Awaited<ReturnType<typeof createApp>>, text: string) =>
  app.inject({ method: "POST", url: "/chat/message", payload: { text } });

describe("chat reply", () => {
  it("replies in the persona voice and emits ai.message_sent", async () => {
    const provider = new FakeLlmProvider({
      reply: (r) => ({ text: `hi ${r.userText}`, toolCalls: [] }),
    });
    const { app, events } = await setup(provider);
    const body = (await send(app, "milk")).json();
    expect(body.ok).toBe(true);
    expect(body.data.reply.text).toBe("hi milk");
    expect(provider.requests[0]?.system).toBe(buildSystemPrompt("en"));
    expect(provider.requests[0]?.system).toContain("My Wife");
    expect(events).toEqual([
      { name: "ai.message_sent", payload: { messageId: body.data.messageId, toolCalls: 0 } },
    ]);
  });

  it("builds a different persona per locale from the locale files", () => {
    expect(buildSystemPrompt("vi")).not.toBe(buildSystemPrompt("en"));
  });

  it("sends a plain error reply, no event and no tool call when the provider is unavailable", async () => {
    const provider = new FakeLlmProvider({
      unavailable: true,
      reply: () => ({ text: "x", toolCalls: [{ tool: "read_status", args: { scope: "budget" } }] }),
    });
    const { app, events } = await setup(provider);
    const body = (await send(app, "hello")).json();
    expect(body.data.reply.text).toBe(
      "Sorry, I cannot answer right now. Please try again in a moment.",
    );
    expect(body.data.degraded).toBe(true);
    expect(body.data.pendingConfirmations).toEqual([]);
    expect(Object.keys(body.data).sort()).toEqual(
      ["degraded", "messageId", "pendingConfirmations", "reply"].sort(),
    );
    expect(events).toEqual([]);
  });

  it("does not execute proposed tool calls on success", async () => {
    const provider = new FakeLlmProvider({
      reply: () => ({
        text: "ok",
        toolCalls: [{ tool: "record_cash_expense", args: { amountVnd: 35000 } }],
      }),
    });
    const { app, events } = await setup(provider);
    const body = (await send(app, "bought milk 35k")).json();
    expect(body.data.pendingConfirmations).toEqual([]);
    expect(events).toHaveLength(1);
    expect((events[0]?.payload as { toolCalls: number }).toolCalls).toBe(0);
  });

  it("returns 400 for an invalid body", async () => {
    const { app } = await setup(new FakeLlmProvider());
    const res = await app.inject({ method: "POST", url: "/chat/message", payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it("replies in vi, including the error reply, with em/anh address terms", async () => {
    const vi = loadConfig({
      SESSION_SECRET: "x".repeat(32),
      LOG_LEVEL: "silent",
      UI_LANGUAGE: "vi",
    });
    const provider = new FakeLlmProvider({ unavailable: true });
    const app = await createApp(vi, { provider });
    const body = (await send(app, "chào")).json();
    expect(body.data.reply.text).toContain("Xin lỗi");
    expect(provider.requests[0]?.locale).toBe("vi");
    const ok = new FakeLlmProvider();
    const app2 = await createApp(vi, { provider: ok });
    expect((await send(app2, "chào")).json().data.reply.text).toBe("chào");
    expect(ok.requests[0]?.system).toContain("em");
    expect(ok.requests[0]?.system).toContain("anh");
    expect(ok.requests[0]?.locale).toBe("vi");
  });

  it("allows only the fake provider before M4", () => {
    expect(createProvider().id).toBe("fake");
    expect(() => createProvider("anthropic")).toThrow();
  });
});
