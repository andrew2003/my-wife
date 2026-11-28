import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { createApp } from "../src/index";
import { FakeLlmProvider } from "../src/llm";

const config = loadConfig({
  SESSION_SECRET: "x".repeat(32),
  LOG_LEVEL: "silent",
  UI_LANGUAGE: "en",
});

const promptCommand = {
  kind: "prompt",
  name: "eli5",
  aliases: [],
  description: { vi: "mo ta", en: "Explain things simply" },
  enabled: true,
  template: "Explain: {text}",
};

async function setup() {
  const provider = new FakeLlmProvider({ reply: () => ({ text: "model answer", toolCalls: [] }) });
  const app = await createApp(config, { provider, readSettings: async () => ({}) });
  const post = async (url: string, payload: unknown) => {
    const res = await app.inject({ method: "POST", url, payload: payload as object });
    return res;
  };
  return { app, provider, post };
}

describe("custom commands through the app wiring", () => {
  it("a created prompt command runs through /chat/message with its description", async () => {
    const { provider, post } = await setup();
    expect((await post("/commands/custom", promptCommand)).statusCode).toBe(201);
    const res = await post("/chat/message", { text: "/eli5 black holes" });
    expect(res.json().data.reply.text).toBe("model answer");
    expect(provider.requests[0]?.system).toContain("Explain things simply");
    expect(provider.requests[0]?.userText).toBe("Explain: black holes");
  });
  it("rejects duplicates, try does not save, delete removes the command", async () => {
    const { app, post } = await setup();
    expect((await post("/commands/custom/try", promptCommand)).statusCode).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/commands/custom" })).json().data.custom,
    ).toEqual([]);
    await post("/commands/custom", promptCommand);
    const dup = await post("/commands/custom", promptCommand);
    expect(dup.statusCode).toBe(422);
    expect(dup.json().error).toBe("duplicate_name");
    expect((await app.inject({ method: "DELETE", url: "/commands/custom/eli5" })).statusCode).toBe(
      200,
    );
    expect((await app.inject({ method: "DELETE", url: "/commands/custom/eli5" })).statusCode).toBe(
      404,
    );
    const after = await post("/chat/message", { text: "/eli5 x" });
    expect(after.json().data.reply.text).toContain("do not know");
  });
});
