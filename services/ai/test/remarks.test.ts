import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { createApp } from "../src/index";
import { FakeLlmProvider } from "../src/llm";
import { RemarkService, checkNumbers } from "../src/remarks";
import { renderMessage } from "../src/i18n";

const FALLBACK_EN = renderMessage({ key: "ai.remark.fallback", params: {} }, "en");
const FALLBACK_VI = renderMessage({ key: "ai.remark.fallback", params: {} }, "vi");
const NOW = new Date("2026-11-28T03:00:00Z");

describe("number check", () => {
  const table: [string, string, Record<string, string | number>, boolean][] = [
    ["no numbers", "Keep going, you are doing well.", {}, true],
    ["exact amount", "You have 1500000 VND left.", { left: 1500000 }, true],
    ["dot grouping", "You have 1.500.000 VND left.", { left: 1500000 }, true],
    ["comma grouping", "You have 1,500,000 VND left.", { left: 1500000 }, true],
    ["wrong amount", "You have 1,600,000 VND left.", { left: 1500000 }, false],
    ["amount not in facts", "You spent 200000 VND.", {}, false],
    ["time ok", "Your focus starts at 07:30.", { start: "07:30" }, true],
    ["time wrong", "Your focus starts at 07:45.", { start: "07:30" }, false],
    ["count ok", "You finished 3 of 5 tasks.", { done: 3, total: 5 }, true],
    ["count wrong", "You finished 4 of 5 tasks.", { done: 3, total: 5 }, false],
    ["decimal ok", "That is 12.5 percent.", { pct: 12.5 }, true],
    ["fact inside text", "Due on 2026-12-01.", { due: "2026-12-01" }, true],
    ["fact text with number", "Six days.", { note: "6 days" }, true],
  ];
  it.each(table)("%s", (_name, text, facts, ok) => {
    expect(checkNumbers(text, facts)).toBe(ok);
  });
});

function setup(
  options: {
    reply?: () => string;
    unavailable?: boolean;
    delayMs?: number;
    degraded?: boolean;
    settings?: Record<string, unknown>;
    timeoutMs?: number;
  } = {},
) {
  let clock = NOW;
  const provider = new FakeLlmProvider({
    reply: () => ({ text: options.reply?.() ?? "Nice work today.", toolCalls: [] }),
    unavailable: options.unavailable,
  });
  const service = new RemarkService({
    provider: {
      id: "x",
      complete: async (r) => {
        if (options.delayMs) await new Promise((res) => setTimeout(res, options.delayMs));
        return provider.complete(r);
      },
    },
    readSettings: async () => options.settings ?? {},
    now: () => clock,
    isDegraded: () => options.degraded ?? false,
    timeoutMs: options.timeoutMs,
  });
  return { service, provider, advance: (ms: number) => (clock = new Date(clock.getTime() + ms)) };
}
const ask = (s: RemarkService, extra: Partial<{ userId: string; screen: string }> = {}) =>
  s.remark({
    userId: extra.userId ?? "u1",
    screen: extra.screen ?? "budget",
    facts: { left: 1500000 },
    locale: "en",
  });

describe("remarks", () => {
  it("sends the fallback when the text has a wrong amount", async () => {
    const { service } = setup({ reply: () => "You have 9,999,000 VND left." });
    expect(await ask(service)).toEqual({ text: FALLBACK_EN, source: "fallback" });
  });

  it("passes a text whose numbers match the facts", async () => {
    const { service } = setup({ reply: () => "You have 1.500.000 VND left." });
    expect(await ask(service)).toEqual({ text: "You have 1.500.000 VND left.", source: "model" });
  });

  it("generates once per user, screen and day and serves the cache", async () => {
    const { service, provider } = setup();
    await ask(service);
    const second = await ask(service);
    expect(provider.requests).toHaveLength(1);
    expect(second.text).toBe("Nice work today.");
    await ask(service, { screen: "schedule" });
    await ask(service, { userId: "u2" });
    expect(provider.requests).toHaveLength(3);
  });

  it("generates once for two concurrent requests", async () => {
    const { service, provider } = setup({ delayMs: 10 });
    await Promise.all([ask(service), ask(service)]);
    expect(provider.requests).toHaveLength(1);
  });

  it("generates again after the cache hours pass", async () => {
    const { service, provider, advance } = setup({
      settings: { "ai.companion_remark_cache_hours": 1 },
    });
    await ask(service);
    advance(30 * 60_000);
    await ask(service);
    expect(provider.requests).toHaveLength(1);
    advance(31 * 60_000);
    await ask(service);
    expect(provider.requests).toHaveLength(2);
  });

  it("caches the fallback after a failed generation", async () => {
    const { service, provider } = setup({ unavailable: true });
    expect((await ask(service)).source).toBe("fallback");
    expect((await ask(service)).text).toBe(FALLBACK_EN);
    expect(provider.requests).toHaveLength(1);
  });

  it("uses the fallback without calling the model in degraded mode", async () => {
    const { service, provider } = setup({ degraded: true });
    expect(await ask(service)).toEqual({ text: FALLBACK_EN, source: "fallback" });
    expect(provider.requests).toHaveLength(0);
  });

  it("uses the fallback on a timeout", async () => {
    const { service } = setup({ delayMs: 200, timeoutMs: 20 });
    expect(await ask(service)).toEqual({ text: FALLBACK_EN, source: "fallback" });
  });

  it("renders the fallback in the requested locale", async () => {
    const { service } = setup({ unavailable: true });
    const out = await service.remark({ userId: "u", screen: "budget", facts: {}, locale: "vi" });
    expect(out.text).toBe(FALLBACK_VI);
    expect(FALLBACK_VI).not.toBe(FALLBACK_EN);
  });
});

describe("POST /remarks", () => {
  const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
  it("returns the remark and rejects a bad body", async () => {
    const app = await createApp(config, {
      provider: new FakeLlmProvider({ reply: () => ({ text: "Well done.", toolCalls: [] }) }),
      readSettings: async () => ({}),
    });
    const ok = await app.inject({
      method: "POST",
      url: "/remarks",
      headers: { "x-user-id": "u1" },
      payload: { screen: "budget", facts: { left: 5 } },
    });
    expect(ok.json()).toMatchObject({ ok: true, data: { text: "Well done.", source: "model" } });
    const bad = await app.inject({ method: "POST", url: "/remarks", payload: { facts: {} } });
    expect(bad.statusCode).toBe(400);
  });
});
