import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { aiEvents, SETTINGS } from "@my-wife/contracts";
import { createApp } from "../src/index";
import { FakeLlmProvider } from "../src/llm";
import { buildSystemPrompt } from "../src/chat/persona";

const config = loadConfig({
  SESSION_SECRET: "x".repeat(32),
  LOG_LEVEL: "silent",
  UI_LANGUAGE: "en",
});

async function setup(values: { current: Record<string, unknown> }) {
  const events: { name: string; payload: unknown }[] = [];
  const provider = new FakeLlmProvider();
  const app = await createApp(config, {
    provider,
    publish: async (e) => {
      events.push(e);
    },
    readSettings: async () => values.current,
  });
  const send = () => app.inject({ method: "POST", url: "/chat/message", payload: { text: "hi" } });
  return { send, events, provider };
}

describe("persona strictness", () => {
  it("has a registry default and one tone per level in both locales", () => {
    expect(SETTINGS["ai.persona_strictness"].default).toBe(3);
    for (const locale of ["en", "vi"] as const) {
      const prompts = [1, 2, 3, 4, 5].map((s) => buildSystemPrompt(locale, [], [], s));
      expect(new Set(prompts).size).toBe(5);
    }
  });

  it("uses the default strictness when nothing is set", () => {
    expect(buildSystemPrompt("en")).toBe(buildSystemPrompt("en", [], [], 3));
  });

  it("follows the changed setting on the next reply and emits persona.updated", async () => {
    const values = { current: { "ai.persona_strictness": 2 } as Record<string, unknown> };
    const { send, events, provider } = await setup(values);
    await send();
    expect(provider.requests[0]?.system).toBe(buildSystemPrompt("en", [], [], 2));
    expect(events.filter((e) => e.name === "persona.updated")).toEqual([]);

    values.current = { "ai.persona_strictness": 5 };
    await send();
    expect(provider.requests[1]?.system).toBe(buildSystemPrompt("en", [], [], 5));
    const updated = events.filter((e) => e.name === "persona.updated");
    expect(updated).toHaveLength(1);
    expect(aiEvents["persona.updated"].parse(updated[0]?.payload)).toEqual({ version: 2 });

    await send();
    expect(events.filter((e) => e.name === "persona.updated")).toHaveLength(1);
  });

  it("falls back to the default for an invalid value", async () => {
    const { send, provider } = await setup({ current: { "ai.persona_strictness": 99 } });
    await send();
    expect(provider.requests[0]?.system).toBe(buildSystemPrompt("en", [], [], 3));
  });
});
