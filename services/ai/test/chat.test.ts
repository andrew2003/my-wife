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
    expect(events).toEqual([]);
  });

  it("allows only the fake provider before M4", () => {
    expect(createProvider().id).toBe("fake");
    expect(() => createProvider("anthropic")).toThrow();
  });
});
