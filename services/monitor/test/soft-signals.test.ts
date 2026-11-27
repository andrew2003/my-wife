import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import type { EventEnvelope } from "@my-wife/contracts";
import { createApp } from "../src/index";
import en from "../src/locales/en.json";
import vi from "../src/locales/vi.json";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const T0 = Date.parse("2026-11-26T03:00:00.000Z");
const at = (sec: number) => new Date(T0 + sec * 1000);

async function setup(settings: Record<string, unknown> = {}) {
  let nowMs = T0;
  const events: EventEnvelope[] = [];
  const app = await createApp(config, {
    now: () => new Date(nowMs),
    publish: (e: EventEnvelope) => void events.push(e),
    readSettings: async () => settings,
  });
  const call = (url: string, payload: unknown) =>
    app.inject({ method: "POST", url, headers: { "x-user-id": "u1" }, payload: payload as object });
  const sessionId = (
    await call("/sessions/start", { taskId: "t1", profile: "camera", deviceId: "dev-a" })
  ).json().data.sessionId as string;
  nowMs = T0 + 6000;
  const beat = (events_: unknown[]) =>
    call("/heartbeat", { sessionId, sentAt: at(6).toISOString(), events: events_ });
  return { app, events, sessionId, beat };
}

const softEvent = (type: string, confidence = 0.9) => ({
  type,
  startedAt: at(5).toISOString(),
  confidence,
});

describe("soft signals produce nudges only", () => {
  it.each(["yawn", "head_down", "looking_away", "drowsy"])(
    "a %s signal gives a nudge, no ticket, no urgent message and no fault",
    async (signal) => {
      const s = await setup();
      const res = await s.beat([softEvent(signal)]);
      expect(res.statusCode).toBe(200);
      expect(res.json().data.nudges).toEqual([{ signal, messageKey: `monitor.nudge.${signal}` }]);
      expect(s.app.monitorState.tickets.all()).toHaveLength(0);
      expect(s.app.monitorState.urgent.all()).toHaveLength(0);
      const types = s.events.map((e) => e.type);
      expect(types).not.toContain("fault.detected");
      expect(types).not.toContain("urgent.sent");
      const detected = s.events.filter((e) => e.type === "focus.signal_detected");
      expect(detected).toHaveLength(1);
      expect(detected[0]?.payload).toMatchObject({
        signal,
        signalClass: "soft",
        sessionId: s.sessionId,
      });
      await s.app.runUrgentJob(at(100000));
      expect(s.events.map((e) => e.type)).not.toContain("fault.detected");
    },
  );

  it("does not nudge twice for a repeated event", async () => {
    const s = await setup();
    await s.beat([softEvent("yawn")]);
    const again = await s.beat([softEvent("yawn")]);
    expect(again.json().data.nudges).toEqual([]);
    expect(s.events.filter((e) => e.type === "focus.signal_detected")).toHaveLength(1);
  });

  it("ignores events below the configured confidence threshold", async () => {
    const s = await setup({ "monitor.ambiguous_confidence_below": 0.8 });
    const res = await s.beat([softEvent("yawn", 0.7), softEvent("drowsy", 0.8)]);
    expect(res.json().data.nudges.map((n: { signal: string }) => n.signal)).toEqual(["drowsy"]);
  });

  it("does not turn a hard signal event into a soft nudge", async () => {
    const s = await setup();
    const res = await s.beat([softEvent("no_face")]);
    expect(res.json().data.nudges).toEqual([]);
    expect(s.events.map((e) => e.type)).not.toContain("focus.signal_detected");
  });

  it("has nudge texts in both locales", () => {
    for (const k of ["yawn", "head_down", "looking_away", "drowsy"]) {
      expect(en).toHaveProperty([`monitor.nudge.${k}`]);
      expect(vi).toHaveProperty([`monitor.nudge.${k}`]);
    }
  });
});
