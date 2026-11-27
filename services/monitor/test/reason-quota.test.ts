import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { SETTINGS, type EventEnvelope } from "@my-wife/contracts";
import { createApp } from "../src/index";
import { decideReasonOutcome, localWeekStart } from "../src/reason-quota";
import en from "../src/locales/en.json";
import vi from "../src/locales/vi.json";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });

describe("localWeekStart (table-driven)", () => {
  const cases: Array<[string, string, string, string]> = [
    // instant, time zone, week start day, expected local date of the week start
    ["2026-11-26T03:00:00Z", "Asia/Ho_Chi_Minh", "monday", "2026-11-23"],
    ["2026-11-22T20:00:00Z", "Asia/Ho_Chi_Minh", "monday", "2026-11-23"],
    ["2026-11-22T10:00:00Z", "Asia/Ho_Chi_Minh", "monday", "2026-11-16"],
    ["2026-11-26T03:00:00Z", "Asia/Ho_Chi_Minh", "sunday", "2026-11-22"],
    ["2026-11-22T10:00:00Z", "Asia/Ho_Chi_Minh", "sunday", "2026-11-22"],
    ["2026-11-26T03:00:00Z", "UTC", "thursday", "2026-11-26"],
  ];
  it.each(cases)("%s in %s, start %s -> %s", (instant, tz, start, expected) => {
    expect(localWeekStart(new Date(instant), tz, start as never)).toBe(expected);
  });
});

describe("decideReasonOutcome (table-driven)", () => {
  const cases: Array<[number, number, "honest" | "silence"]> = [
    // quota, honest reasons already used this week for this type, outcome
    [3, 0, "honest"],
    [3, 2, "honest"],
    [3, 3, "silence"],
    [3, 7, "silence"],
    [0, 0, "silence"],
    [1, 0, "honest"],
    [1, 1, "silence"],
  ];
  it.each(cases)("quota %i, used %i -> %s", (quota, used, expected) => {
    expect(decideReasonOutcome(quota, used)).toBe(expected);
  });
});

describe("reason quota and honest scoring (MW-106)", () => {
  const T0 = Date.parse("2026-11-26T03:00:00.000Z");
  const GAP = SETTINGS["monitor.heartbeat_missing_seconds"].default;
  const QUOTA = SETTINGS["reason.quota_per_week"].default;

  async function setup(settings: Record<string, unknown> = {}) {
    let nowMs = T0;
    const events: EventEnvelope[] = [];
    const app = await createApp(config, {
      now: () => new Date(nowMs),
      publish: (e: EventEnvelope) => void events.push(e),
      readSettings: async () => settings,
      sendUrgent: async () => undefined,
    });
    const call = (url: string, payload?: unknown, user = "u1") =>
      app.inject({
        method: "POST",
        url,
        headers: { "x-user-id": user },
        payload: payload as object,
      });
    const endSessions = async (user = "u1") => {
      for (const s of app.monitorState.sessions.allActive().filter((x) => x.userId === user)) {
        await call(`/sessions/${s.id}/end`, undefined, user);
      }
    };
    /** Opens one more ticket: a new session at the given offset, then a gap check. */
    const openTicket = async (offsetSec: number, user = "u1") => {
      await endSessions(user);
      nowMs = T0 + offsetSec * 1000;
      await call("/sessions/start", { taskId: "t", profile: "camera", deviceId: "d" }, user);
      await app.runGapCheck(new Date(nowMs + GAP * 1000));
      const open = app.monitorState.tickets
        .all()
        .filter((x) => x.userId === user && x.state === "open");
      return open[open.length - 1]!;
    };
    const answer = (ticketId: string, kind: string, offsetSec: number, user = "u1") => {
      nowMs = T0 + offsetSec * 1000;
      return call("/reasons", { ticketId, kind }, user);
    };
    const faults = () => events.filter((e) => e.type === "fault.detected");
    return { app, events, openTicket, answer, faults };
  }

  it("scores an answered ticket as an honest reason (given, with reasonRef)", async () => {
    const s = await setup();
    const t = await s.openTicket(0);
    const res = await s.answer(t.id, "restroom", GAP + 20);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ scoredAs: "honest" });
    expect(s.faults()).toHaveLength(1);
    expect(s.faults()[0]?.payload).toMatchObject({
      signalRef: t.signalRef,
      type: "heartbeat_lost",
      reason: "given",
      reasonRef: t.id,
      reasonKind: "restroom",
      overlapsOutage: false,
    });
  });

  it("emits the fault only once per ticket", async () => {
    const s = await setup();
    const t = await s.openTicket(0);
    await s.answer(t.id, "water", GAP + 20);
    await s.answer(t.id, "water", GAP + 21);
    expect(s.faults()).toHaveLength(1);
  });

  it("counts a reason beyond the weekly quota of its type as silence", async () => {
    const s = await setup();
    const results: string[] = [];
    for (let i = 0; i <= QUOTA; i++) {
      const t = await s.openTicket(i * 3600);
      const res = await s.answer(t.id, "restroom", i * 3600 + GAP + 20);
      results.push(res.json().data.scoredAs);
    }
    expect(results).toEqual([...Array(QUOTA).fill("honest"), "silence"]);
    expect(s.faults()[QUOTA]?.payload).toMatchObject({ reason: "none", reasonKind: "restroom" });
    const given = s.faults().filter((f) => (f.payload as { reason: string }).reason === "given");
    expect(given).toHaveLength(QUOTA);
  });

  it("keeps quotas separate per reason type", async () => {
    const s = await setup({ "reason.quota_per_week": 1 });
    const a = await s.openTicket(0);
    await s.answer(a.id, "restroom", GAP + 1);
    const b = await s.openTicket(3600);
    const res = await s.answer(b.id, "water", 3600 + GAP + 1);
    expect(res.json().data.scoredAs).toBe("honest");
  });

  it("keeps quotas separate per user", async () => {
    const s = await setup({ "reason.quota_per_week": 1 });
    const a = await s.openTicket(0, "u1");
    await s.answer(a.id, "restroom", GAP + 1, "u1");
    const b = await s.openTicket(10, "u2");
    const res = await s.answer(b.id, "restroom", GAP + 11, "u2");
    expect(res.json().data.scoredAs).toBe("honest");
  });

  it("resets the quota in the next local week", async () => {
    const s = await setup({ "reason.quota_per_week": 1 });
    const a = await s.openTicket(0);
    await s.answer(a.id, "restroom", GAP + 1);
    const week = 7 * 24 * 3600;
    const b = await s.openTicket(week);
    const res = await s.answer(b.id, "restroom", week + GAP + 1);
    expect(res.json().data.scoredAs).toBe("honest");
  });

  it("uses the user's time zone and week start for the week boundary", async () => {
    const settings = {
      "reason.quota_per_week": 1,
      "calendar.time_zone": "Asia/Ho_Chi_Minh",
      "calendar.week_start_day": "monday",
    };
    // Sunday 16:00 local (09:00 UTC) and the next day Monday 01:00 local (18:00 UTC Sunday)
    // fall in different local weeks even though they are 9 hours apart.
    const s = await setup(settings);
    const sunday = (Date.parse("2026-11-29T09:00:00Z") - T0) / 1000;
    const a = await s.openTicket(sunday);
    await s.answer(a.id, "restroom", sunday + GAP + 1);
    const monday = (Date.parse("2026-11-29T18:00:00Z") - T0) / 1000;
    const b = await s.openTicket(monday);
    const res = await s.answer(b.id, "restroom", monday + GAP + 1);
    expect(res.json().data.scoredAs).toBe("honest");
    // Within the same local week the second reason is over quota.
    const s2 = await setup(settings);
    const mon = (Date.parse("2026-11-29T18:00:00Z") - T0) / 1000;
    const c = await s2.openTicket(mon);
    await s2.answer(c.id, "restroom", mon + GAP + 1);
    const d = await s2.openTicket(mon + 3600);
    const res2 = await s2.answer(d.id, "restroom", mon + 3600 + GAP + 1);
    expect(res2.json().data.scoredAs).toBe("silence");
  });

  it("scores silence for quota 0 and reports the locale key", async () => {
    const s = await setup({ "reason.quota_per_week": 0 });
    const t = await s.openTicket(0);
    const res = await s.answer(t.id, "other", GAP + 1);
    expect(res.json().data).toMatchObject({
      scoredAs: "silence",
      messageKey: "monitor.reason.over_quota",
    });
    expect(s.faults()[0]?.payload).toMatchObject({ reason: "none" });
  });

  it("ignores an invalid quota setting and uses the default", async () => {
    const s = await setup({ "reason.quota_per_week": -2 });
    const t = await s.openTicket(0);
    const res = await s.answer(t.id, "other", GAP + 1);
    expect(res.json().data.scoredAs).toBe("honest");
  });

  it("does not count silent expiries toward the quota", async () => {
    const s = await setup({ "reason.quota_per_week": 1 });
    const a = await s.openTicket(0);
    a.state = "expired";
    const b = await s.openTicket(10);
    const res = await s.answer(b.id, "restroom", 10 + GAP + 1);
    expect(res.json().data.scoredAs).toBe("honest");
  });

  it("has the over-quota text in both locale files", () => {
    expect(en["monitor.reason.over_quota" as keyof typeof en]).toBeTruthy();
    expect(vi["monitor.reason.over_quota" as keyof typeof vi]).toBeTruthy();
  });
});
