import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { SETTINGS, type EventEnvelope } from "@my-wife/contracts";
import { createApp } from "../src/index";
import { presenceIntervals, type Outage } from "../src/monitoring";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const T0 = Date.parse("2026-11-26T03:00:00.000Z");
const at = (sec: number) => new Date(T0 + sec * 1000);
const iso = (sec: number) => at(sec).toISOString();
const GAP = SETTINGS["monitor.heartbeat_missing_seconds"].default;
const SILENT = SETTINGS["monitor.urgent_silent_fault_after_seconds"].default;
const MARGIN = SETTINGS["monitor.outage_gap_margin_seconds"].default;

async function setup(outages: Outage[], settings: Record<string, unknown> = {}) {
  let nowMs = T0;
  const events: EventEnvelope[] = [];
  const app = await createApp(config, {
    now: () => new Date(nowMs),
    publish: (e: EventEnvelope) => void events.push(e),
    readSettings: async () => settings,
    sendUrgent: async () => undefined,
    listOutages: async () => outages,
  });
  const post = (url: string, payload?: unknown) =>
    app.inject({ method: "POST", url, headers: { "x-user-id": "u1" }, payload: payload as object });
  const sessionId = (
    await post("/sessions/start", { taskId: "t", profile: "camera", deviceId: "d" })
  ).json().data.sessionId as string;
  const setNow = (sec: number) => void (nowMs = T0 + sec * 1000);
  /** Opens the ticket, sends the urgent message, then lets the silence delay pass. */
  const expire = async () => {
    await app.runGapCheck(at(GAP));
    await app.runUrgentJob(at(GAP));
    await app.runUrgentJob(at(GAP + SILENT));
  };
  const fault = () => events.find((e) => e.type === "fault.detected");
  return { app, events, post, sessionId, setNow, expire, fault };
}

describe("outage waiver", () => {
  it("flags a silent fault whose gap overlaps a declared incident", async () => {
    const s = await setup([{ id: "i1", source: "incident", startedAt: iso(5), endedAt: iso(20) }]);
    await s.expire();
    expect(s.fault()?.payload).toMatchObject({ overlapsOutage: true, reason: "none" });
  });

  it("flags a fault whose gap overlaps a platform outage and keeps the audit cause", async () => {
    const s = await setup([{ id: "o1", source: "platform", startedAt: iso(10), endedAt: null }]);
    await s.expire();
    expect(s.fault()?.payload).toMatchObject({ overlapsOutage: true });
    expect(s.app.monitorState.waivers.all()).toEqual([
      expect.objectContaining({ outageId: "o1", source: "platform" }),
    ]);
  });

  it("does not flag a gap with no overlapping outage", async () => {
    const s = await setup([
      { id: "i1", source: "incident", startedAt: iso(-5000), endedAt: iso(-4000) },
    ]);
    await s.expire();
    expect(s.fault()?.payload).toMatchObject({ overlapsOutage: false });
    expect(s.app.monitorState.waivers.all()).toEqual([]);
  });

  it("widens the outage by outage_gap_margin_seconds on both sides", async () => {
    const end = GAP + SILENT;
    const outage: Outage = {
      id: "o1",
      source: "platform",
      startedAt: iso(end + MARGIN),
      endedAt: iso(end + MARGIN + 100),
    };
    const near = await setup([outage]);
    await near.expire();
    expect(near.fault()?.payload).toMatchObject({ overlapsOutage: true });
    const far = await setup([{ ...outage, startedAt: iso(end + MARGIN + 1) }]);
    await far.expire();
    expect(far.fault()?.payload).toMatchObject({ overlapsOutage: false });
  });

  it("uses the user's margin setting", async () => {
    const outage: Outage = {
      id: "o1",
      source: "platform",
      startedAt: iso(GAP + SILENT + 30),
      endedAt: null,
    };
    const s = await setup([outage], { "monitor.outage_gap_margin_seconds": 30 });
    await s.expire();
    expect(s.fault()?.payload).toMatchObject({ overlapsOutage: true });
  });

  it("flags a late answer as overlapping an outage too", async () => {
    const s = await setup([{ id: "i1", source: "incident", startedAt: iso(0), endedAt: iso(50) }]);
    await s.app.runGapCheck(at(GAP));
    s.setNow(GAP + 5);
    const ticketId = s.app.monitorState.tickets.all()[0]!.id;
    const res = await s.post("/reasons", { ticketId, kind: "restroom" });
    expect(res.statusCode).toBe(200);
    expect(s.fault()?.payload).toMatchObject({ overlapsOutage: true, reason: "given" });
  });
});

describe("heartbeat history", () => {
  it("records every server heartbeat and merges close ones into presence intervals", async () => {
    const s = await setup([]);
    for (const sec of [10, 20, 30, 30 + GAP + 100]) {
      s.setNow(sec);
      await s.post("/heartbeat", {
        sessionId: s.sessionId,
        sentAt: "1999-01-01T00:00:00.000Z",
        events: [],
      });
    }
    const times = s.app.monitorState.heartbeats.list(s.sessionId);
    expect(times).toEqual([iso(0), iso(10), iso(20), iso(30), iso(30 + GAP + 100)]);
    expect(presenceIntervals(times, GAP * 1000)).toEqual([
      { from: iso(0), to: iso(30) },
      { from: iso(30 + GAP + 100), to: iso(30 + GAP + 100) },
    ]);
  });
});
