import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { SETTINGS, type EventEnvelope, type OutboundMessage } from "@my-wife/contracts";
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

describe("urgent escalation and reason ticket (MW-036)", () => {
  const CHAT = SETTINGS["monitor.urgent_chat_after_seconds"].default;
  const SILENT = SETTINGS["monitor.urgent_silent_fault_after_seconds"].default;
  const MIN_GAP = SETTINGS["monitor.urgent_min_gap_minutes"].default;

  async function withTicket(
    settings: Record<string, unknown> = {},
    fail = false,
    sendOk: { value: boolean } = { value: true },
    publishFail: { value: boolean } = { value: false },
  ) {
    const sent: OutboundMessage[] = [];
    let nowMs = T0;
    const events: EventEnvelope[] = [];
    const app = await createApp(config, {
      now: () => new Date(nowMs),
      publish: (e: EventEnvelope) => {
        if (publishFail.value && e.type !== "monitor.session_started") throw new Error("bus down");
        events.push(e);
      },
      readSettings: async () => settings,
      sendUrgent: async (m: OutboundMessage) => {
        if (fail || !sendOk.value) throw new Error("notify down");
        sent.push(m);
      },
    });
    const call = (url: string, payload?: unknown, user = "u1") =>
      app.inject({
        method: "POST",
        url,
        headers: { "x-user-id": user },
        payload: payload as object,
      });
    await call("/sessions/start", { taskId: "t1", profile: "camera", deviceId: "d" });
    await app.runGapCheck(at(DEFAULT_GAP));
    const ticket = app.monitorState.tickets.all()[0]!;
    return {
      app,
      events,
      sent,
      call,
      ticket,
      setNow: (sec: number) => void (nowMs = T0 + sec * 1000),
    };
  }
  const types = (e: EventEnvelope[]) => e.map((x) => x.type);
  const channels = (e: EventEnvelope[]) =>
    e
      .filter((x) => x.type === "urgent.sent")
      .map((x) => (x.payload as { channel: string }).channel);

  it("sends the urgent message through notify and emits urgent.sent", async () => {
    const s = await withTicket();
    await s.app.runUrgentJob(at(DEFAULT_GAP));
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toMatchObject({ class: "urgent", sourceService: "monitor", isWakeUp: false });
    const sentEvt = s.events.filter((e) => e.type === "urgent.sent");
    expect(sentEvt).toHaveLength(1);
    expect(sentEvt[0]?.payload).toEqual({ ticketId: s.ticket.id, channel: "web" });
    expect(s.app.monitorState.urgent.all()[0]?.delivered).toBe(true);
  });

  it("does not send twice and keeps the message pending when notify fails", async () => {
    const s = await withTicket();
    await s.app.runUrgentJob(at(DEFAULT_GAP));
    await s.app.runUrgentJob(at(DEFAULT_GAP + 1));
    expect(s.sent).toHaveLength(1);
    const f = await withTicket({}, true);
    const res = await f.app.runUrgentJob(at(DEFAULT_GAP));
    expect(res.failed).toEqual([f.ticket.id]);
    expect(types(f.events)).not.toContain("urgent.sent");
    expect(f.app.monitorState.urgent.all()[0]?.delivered).toBe(false);
  });

  it("sends at most one urgent message per minimum gap for a user", async () => {
    const s = await withTicket({ "monitor.urgent_silent_fault_after_seconds": 3600 });
    await s.app.runUrgentJob(at(DEFAULT_GAP));
    s.app.monitorState.tickets.add({ ...s.ticket, id: "second", signalRef: "second-ref" });
    s.app.monitorState.urgent.add({
      ...s.app.monitorState.urgent.all()[0]!,
      id: "m2",
      ticketId: "second",
      delivered: false,
      sentAt: undefined,
    });
    await s.app.runUrgentJob(at(DEFAULT_GAP + 60));
    expect(s.sent.filter((m) => m.id === "m2")).toHaveLength(0);
    await s.app.runUrgentJob(at(DEFAULT_GAP + MIN_GAP * 60));
    expect(s.sent.filter((m) => m.id === "m2")).toHaveLength(1);
  });

  it("answers within the window: ticket answered and reason.given emitted", async () => {
    const s = await withTicket();
    await s.app.runUrgentJob(at(DEFAULT_GAP));
    s.setNow(DEFAULT_GAP + 20);
    const res = await s.call("/reasons", { ticketId: s.ticket.id, kind: "restroom" });
    expect(res.statusCode).toBe(200);
    expect(s.app.monitorState.tickets.all()[0]).toMatchObject({
      state: "answered",
      reasonKind: "restroom",
    });
    const given = s.events.find((e) => e.type === "reason.given");
    expect(given?.payload).toMatchObject({
      ticketId: s.ticket.id,
      signalRef: s.ticket.signalRef,
      kind: "restroom",
      givenAt: at(DEFAULT_GAP + 20).toISOString(),
    });
    await s.app.runUrgentJob(at(DEFAULT_GAP + SILENT + 10));
    // Answering emits one fault with the honest reason (MW-106); no silent fault follows.
    expect(s.events.filter((e) => e.type === "fault.detected")).toHaveLength(1);
    expect(s.events.find((e) => e.type === "fault.detected")?.payload).toMatchObject({
      reason: "given",
      reasonRef: s.ticket.id,
    });
    expect(types(s.events)).not.toContain("reason.expired");
  });

  it("escalates to chat, then accepts one answer only", async () => {
    const s = await withTicket();
    await s.app.runUrgentJob(at(DEFAULT_GAP));
    await s.app.runUrgentJob(at(DEFAULT_GAP + CHAT));
    expect(s.app.monitorState.tickets.all()[0]?.state).toBe("escalated");
    expect(channels(s.events)).toEqual(["web", "chat"]);
    expect(s.sent).toHaveLength(2);
    const other = await s.call("/reasons", { ticketId: s.ticket.id, kind: "water" }, "u2");
    expect(other.statusCode).toBe(404);
    const bad = await s.call("/reasons", { ticketId: s.ticket.id, kind: "bogus" });
    expect(bad.statusCode).toBe(400);
    expect((await s.call("/reasons", { ticketId: s.ticket.id, kind: "water" })).statusCode).toBe(
      200,
    );
    expect((await s.call("/reasons", { ticketId: s.ticket.id, kind: "water" })).statusCode).toBe(
      409,
    );
    expect(s.events.filter((e) => e.type === "reason.given")).toHaveLength(1);
  });

  it("expires a silent ticket: reason.expired and fault.detected with reason none", async () => {
    const s = await withTicket();
    await s.app.runUrgentJob(at(DEFAULT_GAP));
    await s.app.runUrgentJob(at(DEFAULT_GAP + SILENT - 1));
    expect(types(s.events)).not.toContain("fault.detected");
    await s.app.runUrgentJob(at(DEFAULT_GAP + SILENT));
    await s.app.runUrgentJob(at(DEFAULT_GAP + SILENT + 30));
    expect(s.app.monitorState.tickets.all()[0]?.state).toBe("expired");
    expect(s.events.filter((e) => e.type === "reason.expired")).toHaveLength(1);
    const faults = s.events.filter((e) => e.type === "fault.detected");
    expect(faults).toHaveLength(1);
    expect(faults[0]?.payload).toEqual({
      signalRef: s.ticket.signalRef,
      type: "heartbeat_lost",
      occurredAt: s.ticket.occurredAt,
      reason: "none",
      reasonRef: null,
      reasonKind: null,
      overlapsOutage: false,
    });
    s.setNow(DEFAULT_GAP + SILENT + 40);
    const late = await s.call("/reasons", { ticketId: s.ticket.id, kind: "other" });
    expect(late.statusCode).toBe(409);
  });

  it("takes every delay from user settings", async () => {
    const s = await withTicket({
      "monitor.urgent_chat_after_seconds": 10,
      "monitor.urgent_silent_fault_after_seconds": 20,
    });
    await s.app.runUrgentJob(at(DEFAULT_GAP));
    await s.app.runUrgentJob(at(DEFAULT_GAP + 10));
    expect(s.app.monitorState.tickets.all()[0]?.state).toBe("escalated");
    await s.app.runUrgentJob(at(DEFAULT_GAP + 20));
    expect(types(s.events)).toContain("fault.detected");
  });

  it("never expires a ticket whose urgent message was not delivered", async () => {
    const s = await withTicket({}, true);
    await s.app.runUrgentJob(at(DEFAULT_GAP));
    await s.app.runUrgentJob(at(DEFAULT_GAP + SILENT + 100));
    expect(types(s.events)).not.toContain("reason.expired");
    expect(types(s.events)).not.toContain("fault.detected");
    expect(s.app.monitorState.tickets.all()[0]?.state).toBe("open");
  });

  it("counts the silence from the delivered send, not from the ticket", async () => {
    const ok = { value: false };
    const s = await withTicket({}, false, ok);
    await s.app.runUrgentJob(at(DEFAULT_GAP + 100));
    ok.value = true;
    await s.app.runUrgentJob(at(DEFAULT_GAP + 200));
    await s.app.runUrgentJob(at(DEFAULT_GAP + 200 + SILENT - 1));
    expect(types(s.events)).not.toContain("fault.detected");
    await s.app.runUrgentJob(at(DEFAULT_GAP + 200 + SILENT));
    expect(types(s.events)).toContain("fault.detected");
  });

  it("keeps retrying the chat message after a failed escalation send", async () => {
    const ok = { value: true };
    const s = await withTicket({ "monitor.urgent_silent_fault_after_seconds": 3600 }, false, ok);
    await s.app.runUrgentJob(at(DEFAULT_GAP));
    ok.value = false;
    expect((await s.app.runUrgentJob(at(DEFAULT_GAP + CHAT))).failed).toEqual([s.ticket.id]);
    expect(s.app.monitorState.tickets.all()[0]?.state).toBe("open");
    ok.value = true;
    await s.app.runUrgentJob(at(DEFAULT_GAP + CHAT + 5));
    expect(s.app.monitorState.tickets.all()[0]?.state).toBe("escalated");
    expect(channels(s.events)).toEqual(["web", "chat"]);
  });

  it("accepts an answer after escalation but before the silence delay", async () => {
    const s = await withTicket();
    await s.app.runUrgentJob(at(DEFAULT_GAP));
    await s.app.runUrgentJob(at(DEFAULT_GAP + CHAT));
    s.setNow(DEFAULT_GAP + SILENT - 5);
    expect((await s.call("/reasons", { ticketId: s.ticket.id, kind: "other" })).statusCode).toBe(
      200,
    );
    await s.app.runUrgentJob(at(DEFAULT_GAP + SILENT + 100));
    // Only the honest fault from the answer exists; the silence delay adds no silent fault.
    const faults = s.events.filter((e) => e.type === "fault.detected");
    expect(faults.map((f) => (f.payload as { reason: string }).reason)).toEqual(["given"]);
  });

  it("falls back to the registry defaults for invalid urgent settings", async () => {
    const s = await withTicket({
      "monitor.urgent_chat_after_seconds": -1,
      "monitor.urgent_silent_fault_after_seconds": "soon",
      "monitor.urgent_min_gap_minutes": 0,
    });
    await s.app.runUrgentJob(at(DEFAULT_GAP));
    await s.app.runUrgentJob(at(DEFAULT_GAP + CHAT - 1));
    expect(s.app.monitorState.tickets.all()[0]?.state).toBe("open");
    await s.app.runUrgentJob(at(DEFAULT_GAP + CHAT));
    expect(s.app.monitorState.tickets.all()[0]?.state).toBe("escalated");
    await s.app.runUrgentJob(at(DEFAULT_GAP + SILENT - 1));
    expect(types(s.events)).not.toContain("fault.detected");
    await s.app.runUrgentJob(at(DEFAULT_GAP + SILENT));
    expect(types(s.events)).toContain("fault.detected");
  });

  it("retries after a publish failure instead of losing the event", async () => {
    const pf = { value: true };
    const s = await withTicket({}, false, { value: true }, pf);
    const first = await s.app.runUrgentJob(at(DEFAULT_GAP));
    expect(first.failed).toEqual([s.ticket.id]);
    expect(s.app.monitorState.urgent.all()[0]?.delivered).toBe(false);
    pf.value = false;
    await s.app.runUrgentJob(at(DEFAULT_GAP + 1));
    expect(channels(s.events)).toEqual(["web"]);
    pf.value = true;
    await s.app.runUrgentJob(at(DEFAULT_GAP + SILENT + 1));
    expect(s.app.monitorState.tickets.all()[0]?.state).toBe("open");
    pf.value = false;
    await s.app.runUrgentJob(at(DEFAULT_GAP + SILENT + 2));
    expect(types(s.events)).toContain("fault.detected");
  });

  it("keeps the ticket open when publishing reason.given fails", async () => {
    const pf = { value: false };
    const s = await withTicket({}, false, { value: true }, pf);
    pf.value = true;
    const res = await s.call("/reasons", { ticketId: s.ticket.id, kind: "water" });
    expect(res.statusCode).toBe(500);
    expect(s.app.monitorState.tickets.all()[0]?.state).toBe("open");
  });

  it("does not claim delivery when notify is not wired", async () => {
    const events: EventEnvelope[] = [];
    const app = await createApp(config, { publish: (e: EventEnvelope) => void events.push(e) });
    await app.inject({
      method: "POST",
      url: "/sessions/start",
      headers: { "x-user-id": "u1" },
      payload: { taskId: "t1", profile: "camera", deviceId: "d" },
    });
    await app.runGapCheck(new Date(Date.now() + 3600_000));
    await app.runUrgentJob(new Date(Date.now() + 3600_000));
    expect(events.map((e) => e.type)).not.toContain("urgent.sent");
    expect(app.monitorState.urgent.all()[0]?.delivered).toBe(false);
  });
});
