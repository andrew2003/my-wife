import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { parseEvent, type EventEnvelope } from "@my-wife/contracts";
import { createApp, createMemoryStore } from "../src/index";

const NOW = new Date("2026-01-01T00:00:00Z");
const USER = { "x-user-id": "u1" };

function setup(failPublish = false) {
  const config = loadConfig({ SESSION_SECRET: "s".repeat(32), LOG_LEVEL: "silent" });
  const events: EventEnvelope[] = [];
  let down = failPublish;
  const app = createApp(config, {
    store: createMemoryStore(),
    now: () => NOW,
    publish: (e) => {
      if (down) throw new Error("nats down");
      events.push(e);
    },
  });
  return {
    app,
    events,
    recover: () => {
      down = false;
    },
  };
}
type App = ReturnType<typeof setup>["app"];

const answer = (app: App, answers: unknown, headers: Record<string, string> = USER) =>
  app.inject({ method: "POST", url: "/onboarding/setup-answers", headers, payload: { answers } });
const complete = (
  app: App,
  payload: Record<string, unknown>,
  headers: Record<string, string> = USER,
) => app.inject({ method: "POST", url: "/onboarding/steps", headers, payload });
const values = async (app: App) =>
  (await app.inject({ method: "GET", url: "/settings", headers: USER })).json().data.values;

describe("setup questions", () => {
  it("stores answers as settings and emits one user.updated with the changed keys", async () => {
    const { app, events } = setup();
    const res = await answer(app, { "routine.wake.time": "06:30", "budget.cycle_weeks": 6 });
    expect(res.statusCode).toBe(200);
    const v = await values(app);
    expect(v["routine.wake.time"]).toBe("06:30");
    expect(v["budget.cycle_weeks"]).toBe(6);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "user.updated", userId: "u1" });
    expect(parseEvent(events[0]).success).toBe(true);
    expect((events[0]?.payload as { changedKeys: string[] }).changedKeys.sort()).toEqual([
      "budget.cycle_weeks",
      "routine.wake.time",
    ]);
  });

  it("emits nothing when an answer equals the current value", async () => {
    const { app, events } = setup();
    expect((await answer(app, { "routine.wake.time": "06:00" })).statusCode).toBe(200);
    expect(events).toHaveLength(0);
  });

  it("rejects invalid values and keys that are not setup questions, storing nothing", async () => {
    const { app, events } = setup();
    for (const bad of [
      { "routine.wake.time": "late" },
      { "fault.weight.wake_late": 9 },
      { "routine.wake.time": "06:30", "budget.cycle_weeks": -1 },
      {},
    ]) {
      expect((await answer(app, bad)).statusCode).toBe(400);
    }
    expect((await values(app))["routine.wake.time"]).toBe("06:00");
    expect(events).toHaveLength(0);
  });

  it("requires a verified user id", async () => {
    const { app } = setup();
    expect((await answer(app, { "routine.wake.time": "06:30" }, {})).statusCode).toBe(401);
    expect((await complete(app, { step: "qa_templates" }, {})).statusCode).toBe(401);
  });
});

describe("setup answers atomicity", () => {
  it("stores nothing and emits nothing when the batch cannot be saved", async () => {
    const config = loadConfig({ SESSION_SECRET: "s".repeat(32), LOG_LEVEL: "silent" });
    const events: EventEnvelope[] = [];
    const store = createMemoryStore();
    store.saveSettings = async () => {
      throw new Error("db down");
    };
    const app = createApp(config, { store, now: () => NOW, publish: (e) => void events.push(e) });
    const res = await answer(app, { "routine.wake.time": "06:30", "budget.cycle_weeks": 6 });
    expect(res.statusCode).toBe(500);
    expect(events).toHaveLength(0);
    expect((await values(app))["routine.wake.time"]).toBe("06:00");
  });
});

describe("completing an onboarding step", () => {
  it("emits onboarding.step_completed with skipped false after answers", async () => {
    const { app, events } = setup();
    await answer(app, { "routine.wake.time": "06:30" });
    const res = await complete(app, { step: "qa_templates", skipped: false });
    expect(res.statusCode).toBe(200);
    const last = events[events.length - 1];
    expect(last).toMatchObject({
      type: "onboarding.step_completed",
      userId: "u1",
      payload: { step: "qa_templates", skipped: false },
    });
    expect(parseEvent(last).success).toBe(true);
  });

  it("emits skipped true when the questions were skipped, with defaults kept", async () => {
    const { app, events } = setup();
    expect((await complete(app, { step: "qa_templates", skipped: true })).statusCode).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "onboarding.step_completed",
      payload: { step: "qa_templates", skipped: true },
    });
    expect((await values(app))["routine.wake.time"]).toBe("06:00");
  });

  it("defaults skipped to false and refuses unknown steps", async () => {
    const { app, events } = setup();
    expect((await complete(app, { step: "qa_templates" })).statusCode).toBe(200);
    expect(events[0]?.payload).toEqual({ step: "qa_templates", skipped: false });
    expect((await complete(app, { step: "nope" })).statusCode).toBe(400);
  });

  it("announces a step once even when it is submitted again", async () => {
    const { app, events } = setup();
    await complete(app, { step: "qa_templates", skipped: true });
    const again = await complete(app, { step: "qa_templates", skipped: false });
    expect(again.statusCode).toBe(200);
    expect(events).toHaveLength(1);
  });

  it("retries the owed event when the first publish failed", async () => {
    const { app, events, recover } = setup(true);
    const first = await complete(app, { step: "qa_templates", skipped: true });
    expect(first.statusCode).toBe(503);
    recover();
    expect((await complete(app, { step: "qa_templates", skipped: true })).statusCode).toBe(200);
    expect(events).toHaveLength(1);
  });
});

describe("onboarding step state", () => {
  const state = (app: App, step: string, headers: Record<string, string> = USER) =>
    app.inject({ method: "GET", url: `/onboarding/steps/${step}`, headers });

  it("reports a step as not completed, then as skipped after a skip", async () => {
    const { app } = setup();
    expect((await state(app, "tour")).json().data).toEqual({
      step: "tour",
      completed: false,
      skipped: false,
    });
    await complete(app, { step: "tour", skipped: true });
    expect((await state(app, "tour")).json().data).toEqual({
      step: "tour",
      completed: true,
      skipped: true,
    });
  });

  it("keeps a step open while its event is still owed", async () => {
    const { app } = setup(true);
    await complete(app, { step: "tour", skipped: true });
    expect((await state(app, "tour")).json().data.completed).toBe(false);
  });

  it("rejects an unknown step and an anonymous caller", async () => {
    const { app } = setup();
    expect((await state(app, "nope")).statusCode).toBe(400);
    expect((await state(app, "tour", {})).statusCode).toBe(401);
  });
});
