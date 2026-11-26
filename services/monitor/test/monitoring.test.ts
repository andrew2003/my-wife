import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { SETTINGS, type EventEnvelope } from "@my-wife/contracts";
import { createApp } from "../src/index";
import en from "../src/locales/en.json";
import vi from "../src/locales/vi.json";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const T0 = Date.parse("2026-11-26T03:00:00.000Z");
const at = (sec: number) => new Date(T0 + sec * 1000);
const DEFAULT_GAP = SETTINGS["monitor.heartbeat_missing_seconds"].default;

async function setup(settings: Record<string, unknown> = {}) {
  let nowMs = T0;
  const events: EventEnvelope[] = [];
  const app = await createApp(config, {
    now: () => new Date(nowMs),
    publish: (e: EventEnvelope) => void events.push(e),
    readSettings: async () => settings,
  });
  const call = async (method: "POST" | "GET", url: string, user: string, payload?: unknown) =>
    app.inject({ method, url, headers: { "x-user-id": user }, payload: payload as object });
  const start = (user = "u1", deviceId = "dev-a") =>
    call("POST", "/sessions/start", user, { taskId: "t1", profile: "camera", deviceId });
  return {
    app,
    events,
    call,
    start,
    setNow: (sec: number) => void (nowMs = T0 + sec * 1000),
  };
}

describe("monitor session start", () => {
  it("starts a session with the server time and announces it", async () => {
    const s = await setup();
    const res = await s.start();
    expect(res.statusCode).toBe(200);
    expect(res.json().data.startedAt).toBe(at(0).toISOString());
    expect(s.events.map((e) => e.type)).toEqual(["monitor.session_started"]);
  });

  it("refuses a second device with session.already_active", async () => {
    const s = await setup();
    await s.start("u1", "dev-a");
    const res = await s.start("u1", "dev-b");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ ok: false, error: { code: "session.already_active" } });
    expect(s.events.filter((e) => e.type === "monitor.session_started")).toHaveLength(1);
  });

  it("allows another user at the same time", async () => {
    const s = await setup();
    await s.start("u1");
    expect((await s.start("u2")).statusCode).toBe(200);
  });

  it("requires a user and a valid body", async () => {
    const s = await setup();
    expect(
      (await s.app.inject({ method: "POST", url: "/sessions/start", payload: {} })).statusCode,
    ).toBe(401);
    expect((await s.call("POST", "/sessions/start", "u1", { nope: 1 })).statusCode).toBe(400);
  });
});

describe("heartbeat gap check", () => {
  it("creates a ticket and an urgent message, not a fault, after the gap", async () => {
    const s = await setup();
    const { sessionId } = (await s.start()).json().data;
    s.setNow(5);
    await s.call("POST", "/heartbeat", "u1", { sessionId, sentAt: at(5).toISOString() });
    const before = await s.app.runGapCheck(at(5 + DEFAULT_GAP - 1));
    expect(before.tickets).toEqual([]);
    const res = await s.app.runGapCheck(at(5 + DEFAULT_GAP));
    expect(res.tickets).toHaveLength(1);
    const tickets = s.app.monitorState.tickets.all();
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({
      userId: "u1",
      sessionId,
      state: "open",
      signal: "heartbeat_lost",
    });
    expect(s.events.map((e) => e.type)).not.toContain("fault.detected");
  });

  it("stores the urgent message as a record of class urgent", async () => {
    const s = await setup();
    await s.start();
    await s.app.runGapCheck(at(DEFAULT_GAP));
    const [msg] = s.app.monitorState.urgent.all();
    expect(msg).toMatchObject({
      class: "urgent",
      sourceService: "monitor",
      isWakeUp: false,
      locale: "vi",
      userId: "u1",
      delivered: false,
      message: { key: "monitor.urgent.heartbeat_lost", params: { seconds: DEFAULT_GAP } },
    });
    expect(msg?.ticketId).toBe(s.app.monitorState.tickets.all()[0]?.id);
    expect(Object.keys(vi)).toContain(msg?.message.key);
    expect(Object.keys(en)).toContain(msg?.message.key);
  });

  it("uses the user setting for the gap, not a constant", async () => {
    const s = await setup({ "monitor.heartbeat_missing_seconds": 90 });
    await s.start();
    expect((await s.app.runGapCheck(at(89))).tickets).toEqual([]);
    expect((await s.app.runGapCheck(at(90))).tickets).toHaveLength(1);
  });

  it("falls back to the default for an invalid setting", async () => {
    const s = await setup({ "monitor.heartbeat_missing_seconds": -3 });
    await s.start();
    expect((await s.app.runGapCheck(at(DEFAULT_GAP - 1))).tickets).toEqual([]);
    expect((await s.app.runGapCheck(at(DEFAULT_GAP))).tickets).toHaveLength(1);
  });

  it("opens one ticket per gap however often the check runs", async () => {
    const s = await setup();
    await s.start();
    await s.app.runGapCheck(at(DEFAULT_GAP));
    await s.app.runGapCheck(at(DEFAULT_GAP + 10));
    await s.app.runGapCheck(at(DEFAULT_GAP + 20));
    expect(s.app.monitorState.tickets.all()).toHaveLength(1);
    expect(s.app.monitorState.urgent.all()).toHaveLength(1);
  });

  it("opens a new ticket for a later gap after a heartbeat resumes", async () => {
    const s = await setup();
    const { sessionId } = (await s.start()).json().data;
    await s.app.runGapCheck(at(DEFAULT_GAP));
    s.setNow(100);
    await s.call("POST", "/heartbeat", "u1", { sessionId, sentAt: at(100).toISOString() });
    await s.app.runGapCheck(at(100 + DEFAULT_GAP));
    expect(s.app.monitorState.tickets.all()).toHaveLength(2);
  });

  it("ignores ended sessions", async () => {
    const s = await setup();
    const { sessionId } = (await s.start()).json().data;
    s.setNow(10);
    expect((await s.call("POST", `/sessions/${sessionId}/end`, "u1")).statusCode).toBe(200);
    expect((await s.app.runGapCheck(at(1000))).tickets).toEqual([]);
    expect((await s.start("u1", "dev-b")).statusCode).toBe(200);
  });

  it("rejects a heartbeat with an image field and for unknown sessions", async () => {
    const s = await setup();
    const { sessionId } = (await s.start()).json().data;
    const bad = await s.call("POST", "/heartbeat", "u1", {
      sessionId,
      sentAt: at(1).toISOString(),
      frame: "AAAA",
    });
    expect(bad.statusCode).toBe(400);
    const unknown = await s.call("POST", "/heartbeat", "u1", {
      sessionId: "nope",
      sentAt: at(1).toISOString(),
    });
    expect(unknown.statusCode).toBe(404);
    const other = await s.call("POST", "/heartbeat", "u2", {
      sessionId,
      sentAt: at(1).toISOString(),
    });
    expect(other.statusCode).toBe(404);
  });

  it("ignores the browser clock: the server time decides the gap", async () => {
    const s = await setup();
    const { sessionId } = (await s.start()).json().data;
    s.setNow(10);
    await s.call("POST", "/heartbeat", "u1", {
      sessionId,
      sentAt: "2030-01-01T00:00:00.000Z",
    });
    expect((await s.app.runGapCheck(at(10 + DEFAULT_GAP))).tickets).toHaveLength(1);
  });
});
