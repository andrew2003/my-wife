import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import type { EventEnvelope } from "@my-wife/contracts";
import { createApp } from "../src/index";
import { evaluateLateness } from "../src/checkin-lateness";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const H = { "x-user-id": "u1" };
const CID = "7b0f6f58-0c52-4a3c-9a43-2a0f4b1b9a11";

describe("evaluateLateness (table)", () => {
  const rows: [string, "off" | "remind" | "track" | "commit", number, number, boolean, boolean][] =
    [
      // name, level, grace, minutesLate, recorded, fault
      ["on time at commit", "commit", 15, 0, true, false],
      ["inside grace", "commit", 15, 14, true, false],
      ["exactly at grace", "commit", 15, 15, true, false],
      ["one past grace", "commit", 15, 16, true, true],
      ["grace zero, one minute late", "commit", 0, 1, true, true],
      ["custom grace 30, 20 late", "commit", 30, 20, true, false],
      ["track never faults", "track", 15, 60, true, false],
      ["remind records nothing", "remind", 15, 60, false, false],
      ["off records nothing", "off", 15, 60, false, false],
    ];
  it.each(rows)("%s", (_n, level, grace, minutesLate, recorded, fault) => {
    expect(evaluateLateness({ level, graceMinutes: grace, minutesLate })).toEqual({
      recordCheckin: recorded,
      fault,
    });
  });
});

async function setup(settings: Record<string, unknown>) {
  const events: EventEnvelope[] = [];
  const app = await createApp(config, {
    now: () => new Date("2026-11-23T23:05:00.000Z"),
    publish: (e: EventEnvelope) => void events.push(e),
    readSettings: async () => ({ "routine.wake_photo_window_minutes": 30, ...settings }),
    generateWakeChallenge: async () => ({
      challengeId: CID,
      key: "routine.wake_challenge.sink",
      params: {},
    }),
    sendPhotoRequest: async () => undefined,
    sendReply: async () => undefined,
  });
  await app.inject({
    method: "POST",
    url: "/weeks",
    headers: H,
    payload: { firstDay: "2026-11-23" },
  });
  await app.runWakeJob(new Date("2026-11-23T23:00:00.000Z"));
  const accept = async (sentAt: string) => {
    await app.inject({
      method: "POST",
      url: "/wake/photos",
      headers: H,
      payload: { challengeId: CID, sentAt },
    });
    await app.inject({
      method: "POST",
      url: "/events/photo-graded",
      payload: {
        id: "g1",
        type: "ai.photo_graded",
        occurredAt: sentAt,
        userId: "u1",
        schemaVersion: 1,
        payload: { challengeId: CID, grade: "pass", gradedAt: sentAt },
      },
    });
  };
  const ofType = (t: string) => events.filter((e) => e.type === t);
  return { accept, ofType };
}

describe("wake check-in lateness at commit", () => {
  it("records 14 minutes late with grace 15 and emits no fault", async () => {
    const { accept, ofType } = await setup({ "routine.wake.level": "commit" });
    await accept("2026-11-23T23:14:10.000Z");
    expect(ofType("routine.checkin_recorded")[0]!.payload).toEqual({
      kind: "wake",
      at: "2026-11-23T23:14:10.000Z",
      minutesLate: 14,
    });
    expect(ofType("routine.late_detected")).toHaveLength(0);
  });

  it("emits routine.late_detected at 16 minutes late", async () => {
    const { accept, ofType } = await setup({ "routine.wake.level": "commit" });
    await accept("2026-11-23T23:16:00.000Z");
    expect(ofType("routine.late_detected")).toHaveLength(1);
    expect(ofType("routine.late_detected")[0]!.payload).toEqual({
      routine: "wake",
      faultType: "wake_late",
      occurredAt: "2026-11-23T23:16:00.000Z",
      minutesLate: 16,
    });
  });

  it("honors a configured grace", async () => {
    const { accept, ofType } = await setup({
      "routine.wake.level": "commit",
      "routine.wake_grace_minutes": 20,
    });
    await accept("2026-11-23T23:16:00.000Z");
    expect(ofType("routine.late_detected")).toHaveLength(0);
  });

  it("never faults at track and records nothing at remind", async () => {
    const t = await setup({ "routine.wake.level": "track" });
    await t.accept("2026-11-23T23:25:00.000Z");
    expect(t.ofType("routine.checkin_recorded")).toHaveLength(1);
    expect(t.ofType("routine.late_detected")).toHaveLength(0);
    const r = await setup({ "routine.wake.level": "remind" });
    await r.accept("2026-11-23T23:25:00.000Z");
    expect(r.ofType("routine.checkin_recorded")).toHaveLength(0);
  });
});
