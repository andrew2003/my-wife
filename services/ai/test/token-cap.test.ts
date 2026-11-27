import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { aiEvents } from "@my-wife/contracts";
import { createApp } from "../src/index";
import { FakeLlmProvider } from "../src/llm";
import { dayKeyOf } from "../src/usage";

const config = loadConfig({
  SESSION_SECRET: "x".repeat(32),
  LOG_LEVEL: "silent",
  UI_LANGUAGE: "en",
});

async function setup(settings: Record<string, unknown>, tokensPerCall = 60) {
  let now = new Date("2026-11-28T10:00:00Z");
  const provider = new FakeLlmProvider({
    reply: () => ({ text: "ok", toolCalls: [], usage: { totalTokens: tokensPerCall } }),
  });
  const events: { name: string; payload: unknown }[] = [];
  const app = await createApp(config, {
    provider,
    publish: async (e) => {
      events.push(e);
    },
    readSettings: async () => settings,
    now: () => now,
  });
  const send = async () =>
    (await app.inject({ method: "POST", url: "/chat/message", payload: { text: "hi" } })).json();
  return { provider, events, send, setNow: (d: Date) => (now = d) };
}

const capEvents = (events: { name: string; payload: unknown }[]) =>
  events.filter((e) => e.name === "ai.token_cap_reached");
const refusal =
  "AI has reached its daily token limit. Chat is paused until tomorrow or until you raise the limit in settings. Rules, countdowns and penalties keep working.";

describe("daily token cap", () => {
  it("refuses a call once the cap is reached and emits ai.token_cap_reached", async () => {
    const t = await setup({ "ai.daily_token_cap": 100 });
    expect((await t.send()).data.reply.text).toBe("ok"); // 60 used
    expect((await t.send()).data.reply.text).toBe("ok"); // 120 used, cap reached
    expect((await t.send()).data.reply.text).toBe(refusal);
    expect(t.provider.requests).toHaveLength(2);
    const caps = capEvents(t.events);
    expect(caps).toHaveLength(1);
    expect(aiEvents["ai.token_cap_reached"].parse(caps[0]!.payload)).toEqual({
      day: "2026-11-28",
      cap: 100,
    });
  });

  it("announces the cap once per day", async () => {
    const t = await setup({ "ai.daily_token_cap": 50 });
    await t.send();
    await t.send();
    await t.send();
    expect(capEvents(t.events)).toHaveLength(1);
  });

  it("uses the registry default when the setting is missing", async () => {
    const t = await setup({}, 150000);
    await t.send();
    expect((await t.send()).data.reply.text).toBe("ok"); // 150000 < 200000
    expect((await t.send()).data.reply.text).toBe(refusal);
  });

  it("starts a new day in the user's time zone", async () => {
    const t = await setup({ "ai.daily_token_cap": 50, "calendar.time_zone": "Asia/Ho_Chi_Minh" });
    t.setNow(new Date("2026-11-28T16:00:00Z")); // 23:00 local
    await t.send();
    expect((await t.send()).data.reply.text).toBe(refusal);
    t.setNow(new Date("2026-11-28T18:00:00Z")); // 01:00 next local day
    expect((await t.send()).data.reply.text).toBe("ok");
  });

  it("does not enter degraded mode when refusing", async () => {
    const t = await setup({ "ai.daily_token_cap": 10 });
    await t.send();
    await t.send();
    expect(t.events.some((e) => e.name === "ai.degraded_entered")).toBe(false);
  });
});

describe("dayKeyOf", () => {
  it("uses the time zone and falls back to UTC for a bad zone", () => {
    const at = new Date("2026-11-28T18:00:00Z");
    expect(dayKeyOf(at, "Asia/Ho_Chi_Minh")).toBe("2026-11-29");
    expect(dayKeyOf(at, "UTC")).toBe("2026-11-28");
    expect(dayKeyOf(at, "Not/AZone")).toBe("2026-11-28");
  });
});
