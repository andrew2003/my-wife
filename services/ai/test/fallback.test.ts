import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { createApp } from "../src/index";
import { FakeLlmProvider } from "../src/llm";
import { INITIAL_FAILOVER, nextFailoverState, type FailoverState } from "../src/fallback";

const config = loadConfig({
  SESSION_SECRET: "x".repeat(32),
  LOG_LEVEL: "silent",
  UI_LANGUAGE: "en",
});

class Flaky extends FakeLlmProvider {
  fail = false;
  override async complete(r: Parameters<FakeLlmProvider["complete"]>[0]) {
    if (this.fail) {
      this.requests.push(r);
      throw new Error("down");
    }
    return super.complete(r);
  }
}

async function setup(opts: { threshold?: number; noFallback?: boolean } = {}) {
  const primary = new Flaky({ reply: () => ({ text: "primary", toolCalls: [] }) });
  const fallback = opts.noFallback
    ? undefined
    : new Flaky({ reply: () => ({ text: "fallback", toolCalls: [] }) });
  const events: { name: string; payload: unknown }[] = [];
  const app = await createApp(config, {
    provider: primary,
    fallbackProvider: fallback,
    publish: async (e) => {
      events.push(e);
    },
    readSettings: async () => ({ "ai.fallback_after_failures": opts.threshold ?? 3 }),
  });
  const send = async (text = "hi") =>
    (await app.inject({ method: "POST", url: "/chat/message", payload: { text } })).json();
  const status = async () => (await app.inject({ method: "GET", url: "/status/degraded" })).json();
  return { app, primary, fallback, events, send, status };
}

describe("failover state (table)", () => {
  const s = (o: Partial<FailoverState>): FailoverState => ({ ...INITIAL_FAILOVER, ...o });
  type Row = [
    string,
    FailoverState,
    "primary" | "fallback",
    boolean,
    number,
    Partial<FailoverState>,
  ];
  const table: Row[] = [
    [
      "first primary failure",
      s({}),
      "primary",
      false,
      3,
      { primaryFailures: 1, active: "primary" },
    ],
    [
      "third primary failure",
      s({ primaryFailures: 2 }),
      "primary",
      false,
      3,
      { primaryFailures: 3 },
    ],
    [
      "threshold is configurable",
      s({ primaryFailures: 1 }),
      "primary",
      false,
      2,
      { primaryFailures: 2 },
    ],
    [
      "primary success resets",
      s({ primaryFailures: 2 }),
      "primary",
      true,
      3,
      { primaryFailures: 0, active: "primary" },
    ],
    [
      "fallback failures reach degraded",
      s({ active: "fallback", primaryFailures: 3, fallbackFailures: 2 }),
      "fallback",
      false,
      3,
      { degraded: true },
    ],
    [
      "fallback success exits degraded",
      s({ active: "fallback", primaryFailures: 3, fallbackFailures: 3, degraded: true }),
      "fallback",
      true,
      3,
      { degraded: false, fallbackFailures: 0 },
    ],
  ];
  it.each(table)("%s", (_name, state, role, ok, threshold, expected) => {
    expect(nextFailoverState(state, role, ok, threshold)).toMatchObject(expected);
  });
});

describe("fallback model", () => {
  it("answers with the fallback after 3 primary failures, same memories, and tells the user", async () => {
    const { primary, fallback, send, events } = await setup();
    await send("please remember that I like tea");
    primary.fail = true;
    for (let i = 0; i < 3; i++) await send("hello");
    expect(fallback!.requests).toHaveLength(0);
    const body = await send("what do I like?");
    expect(body.data.reply.text).toContain("fallback");
    expect(body.data.reply.text).toContain("backup model");
    expect(body.data.degraded).toBe(false);
    expect(fallback!.requests[0]?.system).toContain("like tea");
    expect(fallback!.requests[0]?.system).toBe(primary.requests.at(-1)?.system);
    // the user is informed once only
    expect((await send("again")).data.reply.text).toBe("fallback");
    expect(events.some((e) => e.name === "ai.degraded_entered")).toBe(false);
  });

  it("honours a configured threshold", async () => {
    const { primary, fallback, send } = await setup({ threshold: 1 });
    primary.fail = true;
    await send();
    expect((await send()).data.reply.text).toContain("fallback");
    expect(fallback!.requests).toHaveLength(1);
  });
});

describe("degraded mode", () => {
  it("enters degraded when no model works; the banner flag and the reply say so", async () => {
    const { primary, fallback, send, status, events } = await setup();
    primary.fail = true;
    fallback!.fail = true;
    expect((await status()).data).toEqual({ degraded: false, reason: null });
    for (let i = 0; i < 6; i++) await send();
    const body = await send("free text");
    expect(body.data.degraded).toBe(true);
    expect(body.data.reply.text).toContain("inbox");
    expect((await status()).data).toEqual({ degraded: true, reason: "provider_down" });
    expect(events.filter((e) => e.name === "ai.degraded_entered")).toHaveLength(1);
  });

  it("without a fallback, primary failures alone enter degraded", async () => {
    const { primary, send, status } = await setup({ noFallback: true });
    primary.fail = true;
    for (let i = 0; i < 3; i++) await send();
    expect((await status()).data.degraded).toBe(true);
  });

  it("exits degraded on the first success and emits ai.degraded_exited", async () => {
    const { primary, fallback, send, status, events } = await setup();
    primary.fail = true;
    fallback!.fail = true;
    for (let i = 0; i < 6; i++) await send();
    expect((await status()).data.degraded).toBe(true);
    primary.fail = false;
    const body = await send("back");
    expect(body.data.reply.text).toContain("primary");
    expect((await status()).data).toEqual({ degraded: false, reason: null });
    expect(events.filter((e) => e.name === "ai.degraded_exited")).toHaveLength(1);
  });

  it("reports the reason carried by the provider error", async () => {
    const primary = new FakeLlmProvider();
    primary.complete = async () => {
      throw Object.assign(new Error("x"), { reason: "no_credit" });
    };
    const app = await createApp(config, { provider: primary, readSettings: async () => ({}) });
    for (let i = 0; i < 3; i++)
      await app.inject({ method: "POST", url: "/chat/message", payload: { text: "a" } });
    const res = (await app.inject({ method: "GET", url: "/status/degraded" })).json();
    expect(res.data).toEqual({ degraded: true, reason: "no_credit" });
  });

  it("other routes keep working while degraded", async () => {
    const { app, primary, send } = await setup({ noFallback: true });
    primary.fail = true;
    for (let i = 0; i < 3; i++) await send();
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/keys" })).statusCode).toBe(200);
  });
});
