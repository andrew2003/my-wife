import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { createApp } from "../src/index";
import { FakeLlmProvider, type LlmProvider } from "../src/llm";
import { InMemoryLlmKeyStore, type LlmKeyStore } from "../src/keys";
import { renderMessage } from "../src/i18n";

const config = loadConfig({
  SESSION_SECRET: "x".repeat(32),
  UI_LANGUAGE: "en",
  SECRETS_MASTER_KEY: randomBytes(32).toString("base64"),
});

const FACTS = [
  { id: "budget_left", expected: "1.250.000" },
  { id: "late_task", expected: "Coding" },
];

/** Answers every question correctly. */
const goodProvider = () =>
  new FakeLlmProvider({
    reply: () => ({ text: "I checked: 1250000 left, and you are late for Coding.", toolCalls: [] }),
  });
/** Gets the late-task question wrong. */
const oneWrongProvider = () =>
  new FakeLlmProvider({
    reply: (r) => ({
      text:
        r.userText === renderMessage({ key: "ai.handover.q.late_task", params: {} }, "en")
          ? "No idea"
          : "1250000 left",
      toolCalls: [],
    }),
  });

async function setup(
  candidate: LlmProvider,
  opts: { ratio?: number; keyStore?: LlmKeyStore } = {},
) {
  const events: { name: string; payload: unknown }[] = [];
  const keyStore = opts.keyStore ?? new InMemoryLlmKeyStore();
  const app = await createApp(config, {
    keyStore,
    keyValidator: { validate: async () => true },
    readSettings: async () =>
      opts.ratio === undefined ? {} : { "ai.handover_pass_ratio": opts.ratio },
    handoverFacts: async () => FACTS,
    providerFor: () => candidate,
    publish: async (e) => {
      events.push(e);
    },
  });
  const switchTo = (model: string) =>
    app.inject({
      method: "POST",
      url: "/models/switch",
      headers: { "x-user-id": "u1" },
      payload: { provider: "openai", model, role: "primary", apiKey: `sk-key-${model}-123456` },
    });
  return { app, events, keyStore, switchTo };
}

describe("model switching with the handover test", () => {
  it("does not enable a model that fails a question and keeps the old one active", async () => {
    const keyStore = new InMemoryLlmKeyStore();
    const first = await setup(goodProvider(), { keyStore });
    expect((await first.switchTo("old")).statusCode).toBe(200);
    const next = await setup(oneWrongProvider(), { keyStore });
    const res = await next.switchTo("new");
    const body = res.json();
    expect(body.data.state).toBe("failed");
    expect(body.data.failedQuestions).toEqual(["late_task"]);
    expect(body.data.passRatio).toBe(0.5);
    expect(next.events.map((e) => e.name)).toEqual(["ai.handover_failed"]);
    expect((await keyStore.getByRole("u1", "primary"))?.model).toBe("old");
  });

  it("enables a model that passes everything and emits both events", async () => {
    const { events, switchTo, keyStore } = await setup(goodProvider());
    const res = await switchTo("new");
    expect(res.json().data).toMatchObject({ state: "passed", passRatio: 1, failedQuestions: [] });
    const names = events.map((e) => e.name);
    expect(names).toContain("ai.handover_passed");
    expect(names.indexOf("ai.handover_passed")).toBeLessThan(names.indexOf("ai.model_changed"));
    expect(events.find((e) => e.name === "ai.model_changed")?.payload).toEqual({
      role: "primary",
      provider: "openai",
      model: "new",
    });
    expect((await keyStore.getByRole("u1", "primary"))?.model).toBe("new");
  });

  it("honours a lower configured pass ratio", async () => {
    const { switchTo } = await setup(oneWrongProvider(), { ratio: 0.5 });
    expect((await switchTo("m")).json().data.state).toBe("passed");
  });

  it("counts a provider error as a failed question", async () => {
    const { switchTo, keyStore } = await setup(new FakeLlmProvider({ unavailable: true }));
    expect((await switchTo("m")).json().data.state).toBe("failed");
    expect(await keyStore.getByRole("u1", "primary")).toBeNull();
  });

  it("rejects an invalid key without running the test", async () => {
    const app = await createApp(config, {
      keyValidator: { validate: async () => false },
      readSettings: async () => ({}),
      handoverFacts: async () => FACTS,
      providerFor: () => goodProvider(),
    });
    const res = await app.inject({
      method: "POST",
      url: "/models/switch",
      headers: { "x-user-id": "u1" },
      payload: { provider: "openai", model: "m", role: "primary", apiKey: "sk-bad-123456" },
    });
    expect(res.statusCode).toBe(422);
  });

  it("never echoes the key and reports the persona score as informational", async () => {
    const { switchTo } = await setup(goodProvider());
    const res = await switchTo("m");
    expect(res.body).not.toContain("sk-key-");
    expect(res.json().data.personaScore).toBe(1);
  });

  const payload = { provider: "openai", model: "m", role: "primary", apiKey: "sk-key-m-123456" };

  it("fails closed with 503 when no provider adapter is available", async () => {
    const events: { name: string }[] = [];
    const app = await createApp(config, {
      keyValidator: { validate: async () => true },
      readSettings: async () => ({}),
      handoverFacts: async () => FACTS,
      publish: async (e) => {
        events.push(e);
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/models/switch",
      headers: { "x-user-id": "u1" },
      payload,
    });
    expect(res.statusCode).toBe(503);
    expect(events).toEqual([]);
  });

  it("does not enable a model when there are no handover facts", async () => {
    const events: { name: string }[] = [];
    const keyStore = new InMemoryLlmKeyStore();
    const app = await createApp(config, {
      keyStore,
      keyValidator: { validate: async () => true },
      readSettings: async () => ({}),
      handoverFacts: async () => [],
      providerFor: () => goodProvider(),
      publish: async (e) => {
        events.push(e);
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/models/switch",
      headers: { "x-user-id": "u1" },
      payload,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("not_ready");
    expect(events).toEqual([]);
    expect(await keyStore.getByRole("u1", "primary")).toBeNull();
  });

  it("rejects a request without a user id", async () => {
    const { app } = await setup(goodProvider());
    const res = await app.inject({ method: "POST", url: "/models/switch", payload });
    expect(res.statusCode).toBe(401);
  });

  it("fails a fact whose question has no locale entry", async () => {
    const app = await createApp(config, {
      keyValidator: { validate: async () => true },
      readSettings: async () => ({}),
      handoverFacts: async () => [{ id: "unknown_question", expected: "x" }],
      providerFor: () => goodProvider(),
    });
    const res = await app.inject({
      method: "POST",
      url: "/models/switch",
      headers: { "x-user-id": "u1" },
      payload,
    });
    expect(res.json().data).toMatchObject({
      state: "failed",
      failedQuestions: ["unknown_question"],
    });
  });
});
