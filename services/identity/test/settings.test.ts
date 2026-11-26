import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import {
  GetSettingsResponseSchema,
  SETTINGS,
  SETTING_KEYS,
  UpdateSettingResponseSchema,
  parseEvent,
  type EventEnvelope,
} from "@my-wife/contracts";
import { createApp, createMemoryStore } from "../src/index";

const NOW = new Date("2026-01-01T00:00:00Z");
const USER = { "x-user-id": "u1" };

function setup(failPublish = false) {
  const config = loadConfig({ SESSION_SECRET: "s".repeat(32), LOG_LEVEL: "silent" });
  const events: EventEnvelope[] = [];
  const store = createMemoryStore();
  const app = createApp(config, {
    store,
    now: () => NOW,
    publish: (e) => {
      if (failPublish) throw new Error("nats down");
      events.push(e);
    },
  });
  return { app, store, events };
}

type App = ReturnType<typeof setup>["app"];

const get = (app: App, headers: Record<string, string> = USER) =>
  app.inject({ method: "GET", url: "/settings", headers });
const put = (app: App, key: string, value: unknown) =>
  app.inject({ method: "PUT", url: "/settings", headers: USER, payload: { key, value } });

describe("user settings", () => {
  it("returns every registry default for a new user", async () => {
    const { app } = setup();
    const res = await get(app);
    expect(res.statusCode).toBe(200);
    expect(GetSettingsResponseSchema.safeParse(res.json()).success).toBe(true);
    const values = res.json().data.values as Record<string, unknown>;
    expect(Object.keys(values).sort()).toEqual([...SETTING_KEYS].sort());
    for (const key of SETTING_KEYS) {
      expect(values[key]).toEqual(SETTINGS[key].default);
    }
  });

  it("requires a verified user id", async () => {
    const { app } = setup();
    expect((await get(app, {})).statusCode).toBe(401);
  });

  it("saves a change, emits user.updated and returns the new value next read", async () => {
    const { app, events } = setup();
    const res = await put(app, "budget.cycle_weeks", 6);
    expect(res.statusCode).toBe(200);
    expect(UpdateSettingResponseSchema.safeParse(res.json()).success).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "user.updated",
      userId: "u1",
      payload: { changedKeys: ["budget.cycle_weeks"] },
    });
    expect(parseEvent(events[0]).success).toBe(true);
    const next = (await get(app)).json().data.values;
    expect(next["budget.cycle_weeks"]).toBe(6);
    expect(next["budget.tolerance_percent"]).toBe(SETTINGS["budget.tolerance_percent"].default);
  });

  it("keeps settings separate per user", async () => {
    const { app } = setup();
    await put(app, "budget.cycle_weeks", 6);
    const other = await get(app, { "x-user-id": "u2" });
    expect(other.json().data.values["budget.cycle_weeks"]).toBe(4);
  });

  it("rejects unknown keys and invalid values without emitting", async () => {
    const { app, events } = setup();
    expect((await put(app, "nope.key", 1)).statusCode).toBe(400);
    expect((await put(app, "budget.cycle_weeks", -2)).statusCode).toBe(400);
    expect(events).toHaveLength(0);
  });

  it("does not emit when the value is unchanged", async () => {
    const { app, events } = setup();
    await put(app, "budget.cycle_weeks", 4);
    expect(events).toHaveLength(0);
  });

  it("writes an audit entry and keeps the saved value when publishing fails", async () => {
    const { app, store } = setup(true);
    const res = await put(app, "budget.cycle_weeks", 6);
    expect(res.statusCode).toBe(200);
    expect((await get(app)).json().data.values["budget.cycle_weeks"]).toBe(6);
    const audit = await store.listSettingAudit("u1");
    expect(audit).toEqual([
      expect.objectContaining({
        key: "budget.cycle_weeks",
        before: 4,
        after: 6,
        actorId: "u1",
        at: NOW.toISOString(),
      }),
    ]);
  });
});
