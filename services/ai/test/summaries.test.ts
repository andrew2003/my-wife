import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { SETTINGS } from "@my-wife/contracts";
import { createApp } from "../src/index";
import { FakeLlmProvider } from "../src/llm";
import { InMemoryConversationStore } from "../src/conversation";
import { InMemoryMemoryStore } from "../src/memory";

const config = loadConfig({
  SESSION_SECRET: "x".repeat(32),
  LOG_LEVEL: "silent",
  UI_LANGUAGE: "en",
});
const TRIGGER = SETTINGS["ai.summary_trigger_messages"].default;
const KEPT = SETTINGS["ai.recent_messages_kept"].default;

async function setup(
  provider = new FakeLlmProvider({ reply: () => ({ text: "SUMMARY", toolCalls: [] }) }),
  extra: { summaryMaxLength?: number } = {},
) {
  const events: { name: string; payload: unknown }[] = [];
  const memoryStore = new InMemoryMemoryStore();
  const conversationStore = new InMemoryConversationStore();
  const app = await createApp(config, {
    provider,
    memoryStore,
    conversationStore,
    readSettings: async () => ({}),
    ...extra,
    publish: async (e) => {
      events.push(e);
    },
  });
  return { app, events, memoryStore, conversationStore, provider };
}
const fill = async (store: InMemoryConversationStore, user: string, n: number) => {
  for (let i = 0; i < n; i += 1)
    await store.append({
      userId: user,
      role: i % 2 ? "assistant" : "user",
      text: `m${i}`,
      at: new Date(2026, 0, 1, 0, i),
    });
};
const runJob = (app: Awaited<ReturnType<typeof createApp>>) =>
  app.inject({ method: "POST", url: "/jobs/summaries" });

describe("conversation summaries", () => {
  it("summarises a long conversation and compacts old turns", async () => {
    const { app, memoryStore, conversationStore, events } = await setup();
    await fill(conversationStore, "u1", TRIGGER);
    const res = await runJob(app);
    expect(res.json().data.summarised).toBe(1);
    const memories = await memoryStore.list("u1");
    expect(memories.map((m) => m.source)).toEqual(["summary"]);
    expect(memories[0]?.fact).toBe("SUMMARY");
    const left = await conversationStore.listActive("u1");
    expect(left).toHaveLength(KEPT);
    expect(left[0]?.text).toBe(`m${TRIGGER - KEPT}`);
    expect(events.filter((e) => e.name === "memory.created")).toHaveLength(1);
  });

  it("does nothing below the trigger", async () => {
    const { app, memoryStore, conversationStore, provider } = await setup();
    await fill(conversationStore, "u1", TRIGGER - 1);
    const res = await runJob(app);
    expect(res.json().data.summarised).toBe(0);
    expect(await memoryStore.list("u1")).toHaveLength(0);
    expect(await conversationStore.listActive("u1")).toHaveLength(TRIGGER - 1);
    expect(provider.requests).toHaveLength(0);
  });

  it("keeps the turns when the model fails", async () => {
    const { app, memoryStore, conversationStore } = await setup(
      new FakeLlmProvider({ unavailable: true }),
    );
    await fill(conversationStore, "u1", TRIGGER);
    const res = await runJob(app);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.summarised).toBe(0);
    expect(await memoryStore.list("u1")).toHaveLength(0);
    expect(await conversationStore.listActive("u1")).toHaveLength(TRIGGER);
  });

  it("drops an oversized summary and keeps the turns", async () => {
    const provider = new FakeLlmProvider({
      reply: () => ({ text: "x".repeat(50), toolCalls: [] }),
    });
    const { app, memoryStore, conversationStore } = await setup(provider, { summaryMaxLength: 49 });
    await fill(conversationStore, "u1", TRIGGER);
    const res = await runJob(app);
    expect(res.json().data.summarised).toBe(0);
    expect(await memoryStore.list("u1")).toHaveLength(0);
    expect(await conversationStore.listActive("u1")).toHaveLength(TRIGGER);
  });

  it("drops a blank summary and a duplicate one", async () => {
    const blank = await setup(
      new FakeLlmProvider({ reply: () => ({ text: "  ", toolCalls: [] }) }),
    );
    await fill(blank.conversationStore, "u1", TRIGGER);
    expect((await runJob(blank.app)).json().data.summarised).toBe(0);
    expect(await blank.memoryStore.list("u1")).toHaveLength(0);

    const dup = await setup();
    await dup.memoryStore.add({
      userId: "u1",
      fact: "SUMMARY",
      source: "user_answer",
      createdAt: new Date(),
    });
    await fill(dup.conversationStore, "u1", TRIGGER);
    expect((await runJob(dup.app)).json().data.summarised).toBe(0);
    expect(await dup.memoryStore.list("u1")).toHaveLength(1);
  });

  it("places a summary in a separate informational block, not among facts", async () => {
    const { app, memoryStore, provider } = await setup();
    await memoryStore.add({
      userId: "u1",
      fact: "SUM TEXT",
      source: "summary",
      createdAt: new Date(),
    });
    await app.inject({
      method: "POST",
      url: "/chat/message",
      headers: { "x-user-id": "u1" },
      payload: { text: "hi" },
    });
    const system = provider.requests.at(-1)?.system ?? "";
    expect(system).toContain("- SUM TEXT");
    expect(system).toContain("informational only");
    expect(system.indexOf("informational only")).toBeLessThan(system.indexOf("- SUM TEXT"));
    expect(system).not.toContain("Known facts about the user");
  });

  it("sends the old turns as data, not as the system prompt", async () => {
    const { app, conversationStore, provider } = await setup();
    await fill(conversationStore, "u1", TRIGGER);
    await runJob(app);
    expect(provider.requests[0]?.userText).toContain("m0");
    expect(provider.requests[0]?.system).not.toContain("m0");
  });
});

describe("memory deletion", () => {
  it("deletes a memory and emits memory.deleted", async () => {
    const { app, memoryStore, events } = await setup();
    const row = await memoryStore.add({
      userId: "u1",
      fact: "likes tea",
      source: "user_answer",
      createdAt: new Date(),
    });
    const res = await app.inject({
      method: "DELETE",
      url: `/memories/${row.id}`,
      headers: { "x-user-id": "u1" },
    });
    expect(res.statusCode).toBe(200);
    expect(await memoryStore.list("u1")).toHaveLength(0);
    expect(events).toContainEqual({ name: "memory.deleted", payload: { memoryId: row.id } });
  });

  it("does not delete another user's memory", async () => {
    const { app, memoryStore, events } = await setup();
    const row = await memoryStore.add({
      userId: "u1",
      fact: "likes tea",
      source: "user_answer",
      createdAt: new Date(),
    });
    const res = await app.inject({
      method: "DELETE",
      url: `/memories/${row.id}`,
      headers: { "x-user-id": "u2" },
    });
    expect(res.statusCode).toBe(404);
    expect(await memoryStore.list("u1")).toHaveLength(1);
    expect(events.some((e) => e.name === "memory.deleted")).toBe(false);
  });
});
