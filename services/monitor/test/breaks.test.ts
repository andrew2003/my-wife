import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { SETTINGS, type EventEnvelope } from "@my-wife/contracts";
import { createApp } from "../src/index";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const T0 = Date.parse("2026-11-26T03:00:00.000Z");
const DEFAULT_GAP = SETTINGS["monitor.heartbeat_missing_seconds"].default;
const BREAK_MIN = SETTINGS["monitor.break_max_minutes"].default;
const PER_DAY = SETTINGS["monitor.breaks_per_day"].default;

async function setup(settings: Record<string, unknown> = {}) {
  let nowMs = T0;
  const events: EventEnvelope[] = [];
  const app = await createApp(config, {
    now: () => new Date(nowMs),
    publish: (e: EventEnvelope) => void events.push(e),
    readSettings: async () => settings,
  });
  const post = (url: string, payload?: unknown, user = "u1") =>
    app.inject({ method: "POST", url, headers: { "x-user-id": user }, payload: payload as object });
  const start = async () => {
    const res = await post("/sessions/start", { taskId: "t1", profile: "camera", deviceId: "d" });
    return res.json().data.sessionId as string;
  };
  const setNow = (sec: number) => void (nowMs = T0 + sec * 1000);
  const gap = (sec: number) => app.runGapCheck(new Date(T0 + sec * 1000));
  return { app, events, post, start, setNow, gap };
}

describe("breaks and pauses", () => {
  it("raises no gap fault while a break lasts", async () => {
    const s = await setup();
    const sessionId = await s.start();
    s.setNow(10);
    expect((await s.post("/breaks/start", { sessionId })).statusCode).toBe(200);
    expect(s.events.map((e) => e.type)).toContain("break.started");
    expect((await s.gap(BREAK_MIN * 60 - 1)).tickets).toEqual([]);
  });

  it("counts absence from the end of the allowed break, with no retroactive ticket", async () => {
    const s = await setup();
    const sessionId = await s.start();
    s.setNow(10);
    await s.post("/breaks/start", { sessionId });
    const allowedEnd = 10 + BREAK_MIN * 60;
    expect((await s.gap(allowedEnd + DEFAULT_GAP - 1)).tickets).toEqual([]);
    expect((await s.gap(allowedEnd + DEFAULT_GAP)).tickets).toHaveLength(1);
  });

  it("resumes normal monitoring when the break ends, counting from its end", async () => {
    const s = await setup();
    const sessionId = await s.start();
    s.setNow(10);
    await s.post("/breaks/start", { sessionId });
    s.setNow(100);
    expect((await s.post("/breaks/end", { sessionId })).statusCode).toBe(200);
    expect(s.events.map((e) => e.type)).toContain("break.ended");
    expect((await s.gap(100 + DEFAULT_GAP - 1)).tickets).toEqual([]);
    expect((await s.gap(100 + DEFAULT_GAP)).tickets).toHaveLength(1);
  });

  it("uses the user's break_max_minutes setting", async () => {
    const s = await setup({ "monitor.break_max_minutes": 2 });
    const sessionId = await s.start();
    await s.post("/breaks/start", { sessionId });
    expect(s.events.find((e) => e.type === "break.started")?.payload).toMatchObject({
      maxMinutes: 2,
    });
    expect((await s.gap(120 + DEFAULT_GAP)).tickets).toHaveLength(1);
  });

  it("refuses a break beyond breaks_per_day with break.quota_exceeded", async () => {
    const s = await setup({ "monitor.breaks_per_day": 1 });
    const sessionId = await s.start();
    expect((await s.post("/breaks/start", { sessionId })).statusCode).toBe(200);
    await s.post("/breaks/end", { sessionId });
    const res = await s.post("/breaks/start", { sessionId });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("break.quota_exceeded");
  });

  it("has a default daily allowance from the registry", async () => {
    const s = await setup();
    const sessionId = await s.start();
    for (let i = 0; i < PER_DAY; i++) {
      expect((await s.post("/breaks/start", { sessionId })).statusCode).toBe(200);
      await s.post("/breaks/end", { sessionId });
    }
    expect((await s.post("/breaks/start", { sessionId })).statusCode).toBe(409);
  });

  it("scheduled breaks (pomodoro, meal) last their planned minutes and use no quota", async () => {
    const s = await setup({ "monitor.breaks_per_day": 0 });
    const sessionId = await s.start();
    const res = await s.app.startScheduledBreak("u1", sessionId, 30);
    expect(res.ok).toBe(true);
    expect((await s.gap(30 * 60 - 1)).tickets).toEqual([]);
    expect((await s.gap(30 * 60 + DEFAULT_GAP)).tickets).toHaveLength(1);
  });

  it("offers no user-facing route to choose a break length", async () => {
    const s = await setup();
    const sessionId = await s.start();
    const res = await s.post("/breaks/scheduled", { sessionId, minutes: 100000 });
    expect(res.statusCode).toBe(404);
    expect((await s.gap(BREAK_MIN * 60 + DEFAULT_GAP)).tickets).toHaveLength(1);
  });

  it("does not let an expired break block a new one", async () => {
    const s = await setup();
    const sessionId = await s.start();
    await s.post("/breaks/start", { sessionId });
    s.setNow(BREAK_MIN * 60 + 1);
    const res = await s.post("/breaks/start", { sessionId });
    expect(res.statusCode).toBe(200);
    expect(s.events.filter((e) => e.type === "break.ended")).toHaveLength(1);
  });

  it("stores no break when the start event cannot be published", async () => {
    let fail = true;
    const app = await createApp(config, {
      now: () => new Date(T0),
      publish: (e: EventEnvelope) => {
        if (fail && e.type === "break.started") throw new Error("bus down");
      },
    });
    const h = { "x-user-id": "u1" };
    const started = await app.inject({
      method: "POST",
      url: "/sessions/start",
      headers: h,
      payload: { taskId: "t1", profile: "camera", deviceId: "d" },
    });
    const sessionId = started.json().data.sessionId as string;
    const start = () =>
      app.inject({ method: "POST", url: "/breaks/start", headers: h, payload: { sessionId } });
    expect((await start()).statusCode).toBe(500);
    fail = false;
    expect((await start()).statusCode).toBe(200);
  });

  it("refuses a second break while one is running and unknown sessions", async () => {
    const s = await setup();
    const sessionId = await s.start();
    await s.post("/breaks/start", { sessionId });
    expect((await s.post("/breaks/start", { sessionId })).statusCode).toBe(409);
    expect((await s.post("/breaks/start", { sessionId: "nope" })).statusCode).toBe(404);
    expect((await s.post("/breaks/start", { sessionId }, "u2")).statusCode).toBe(404);
    expect((await s.post("/breaks/start", {})).statusCode).toBe(400);
  });
});
