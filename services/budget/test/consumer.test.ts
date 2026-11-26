import { describe, expect, it, vi } from "vitest";
import type { EventEnvelope } from "@my-wife/contracts";
import { createSettingsReader, runOnboardingConsumer } from "../src/consumer";

const envelope = (type: string, payload: unknown) =>
  JSON.stringify({
    id: "e1",
    type,
    occurredAt: "2026-03-02T09:00:00Z",
    userId: "u1",
    schemaVersion: 1,
    payload,
  });

function run(messages: string[], prefix = "wt1") {
  const subscribed: { subject: string; queue: string }[] = [];
  const handled: EventEnvelope[] = [];
  const log = { warn: vi.fn(), error: vi.fn() };
  const nats = {
    subscribe(subject: string, opts: { queue: string }) {
      subscribed.push({ subject, queue: opts.queue });
      return (async function* () {
        for (const m of messages) yield { string: () => m };
      })();
    },
  };
  const done = runOnboardingConsumer({
    nats,
    prefix,
    log,
    handler: async (e) => {
      handled.push(e);
    },
  });
  return { done, subscribed, handled, log };
}

describe("onboarding consumer", () => {
  it("subscribes under the subject prefix in a queue group", async () => {
    const { done, subscribed } = run([]);
    await done;
    expect(subscribed).toEqual([{ subject: "wt1.onboarding.step_completed", queue: "budget" }]);
  });

  it("uses the bare subject without a prefix", async () => {
    const { done, subscribed } = run([], "");
    await done;
    expect(subscribed[0]!.subject).toBe("onboarding.step_completed");
  });

  it("passes a valid parsed event to the handler", async () => {
    const { done, handled } = run([
      envelope("onboarding.step_completed", { step: "qa_templates", skipped: true }),
    ]);
    await done;
    expect(handled).toHaveLength(1);
    expect(handled[0]).toMatchObject({ type: "onboarding.step_completed", userId: "u1" });
  });

  it.each([
    { name: "invalid payload", raw: envelope("onboarding.step_completed", { step: "nope" }) },
    { name: "unknown type", raw: envelope("something.else", {}) },
    { name: "other known type", raw: envelope("user.activated", {}) },
    { name: "malformed json", raw: "{not json" },
  ])("drops $name and keeps consuming", async ({ raw }) => {
    const good = envelope("onboarding.step_completed", { step: "qa_templates", skipped: false });
    const { done, handled } = run([raw, good]);
    await done;
    expect(handled).toHaveLength(1);
  });

  it("logs a handler failure and continues", async () => {
    const log = { warn: vi.fn(), error: vi.fn() };
    const good = envelope("onboarding.step_completed", { step: "qa_templates", skipped: false });
    let calls = 0;
    await runOnboardingConsumer({
      prefix: "",
      log,
      nats: {
        subscribe: () =>
          (async function* () {
            yield { string: () => good };
            yield { string: () => good };
          })(),
      },
      handler: async () => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
      },
    });
    expect(calls).toBe(2);
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});

describe("settings reader", () => {
  const ok = (values: unknown) =>
    ({ ok: true, json: async () => ({ ok: true, data: { values } }) }) as Response;

  it("reads values from identity with the user header", async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: unknown) => ok({ "budget.cycle_weeks": 2 }));
    const read = createSettingsReader({ identityUrl: "http://id", fetchFn: fetchFn as never });
    expect(await read("u1")).toEqual({ "budget.cycle_weeks": 2 });
    expect(fetchFn).toHaveBeenCalledWith("http://id/settings", { headers: { "x-user-id": "u1" } });
  });

  it.each([
    { name: "http error", fetchFn: async () => ({ ok: false }) as Response },
    { name: "network failure", fetchFn: async () => Promise.reject(new Error("down")) },
    { name: "bad body", fetchFn: async () => ({ ok: true, json: async () => ({}) }) as Response },
  ])("returns {} on $name", async ({ fetchFn }) => {
    const read = createSettingsReader({ identityUrl: "http://id", fetchFn: fetchFn as never });
    expect(await read("u1")).toEqual({});
  });
});
