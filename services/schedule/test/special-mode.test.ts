import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import type { EventEnvelope } from "@my-wife/contracts";
import { createApp } from "../src/index";
import {
  cycleKeyOf,
  planPeriod,
  resolveSpecialModeSettings,
  type SpecialModeSettings,
} from "../src/special-mode";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const H = { "x-user-id": "u1" };
// 2026-11-27 08:00 in Ho Chi Minh (UTC+7) is 01:00Z.
const NOW = new Date("2026-11-27T01:00:00Z");
const settings: SpecialModeSettings = {
  daysPerCycle: 5,
  retroactiveHours: 24,
  cycleDays: 28,
  zone: "Asia/Ho_Chi_Minh",
};
const base = { now: NOW, settings, cycleFirstDays: ["2026-11-02"], existing: [] };

describe("resolveSpecialModeSettings", () => {
  it.each([
    [{}, 5, 24, 28],
    [
      { "schedule.special_mode_days_per_cycle": 2, "schedule.sick_retroactive_hours": 48 },
      2,
      48,
      28,
    ],
    [
      { "schedule.special_mode_days_per_cycle": -1, "schedule.sick_retroactive_hours": "x" },
      5,
      24,
      28,
    ],
    [{ "budget.cycle_weeks": 2 }, 5, 24, 14],
  ])("%j -> days %i, hours %i, cycle days %i", (values, days, hours, cycle) => {
    const s = resolveSpecialModeSettings(values);
    expect([s.daysPerCycle, s.retroactiveHours, s.cycleDays]).toEqual([days, hours, cycle]);
  });
});

describe("cycleKeyOf", () => {
  it.each([
    ["2026-11-02", "2026-11-02"],
    ["2026-11-29", "2026-11-02"],
    ["2026-11-30", "none"],
    ["2026-11-01", "none"],
  ])("%s -> %s", (day, key) => {
    expect(cycleKeyOf(day, ["2026-11-02"], 28)).toBe(key);
  });
});

describe("planPeriod (table-driven window and quota rules)", () => {
  const cases: {
    name: string;
    input: Partial<Parameters<typeof planPeriod>[0]>;
    code?: string;
    retroactive?: boolean;
  }[] = [
    {
      name: "sick yesterday with a reason is retroactive",
      input: { kind: "sick", fromDay: "2026-11-26", toDay: "2026-11-26", reason: "fever" },
      retroactive: true,
    },
    {
      name: "sick yesterday needs a reason",
      input: { kind: "sick", fromDay: "2026-11-26", toDay: "2026-11-26" },
      code: "schedule.special_mode_reason_required",
    },
    {
      name: "blank reason does not count",
      input: { kind: "sick", fromDay: "2026-11-26", toDay: "2026-11-26", reason: "  " },
      code: "schedule.special_mode_reason_required",
    },
    {
      name: "the day before yesterday ended 32 hours ago",
      input: { kind: "sick", fromDay: "2026-11-25", toDay: "2026-11-25", reason: "flu" },
      code: "schedule.special_mode_window_exceeded",
    },
    {
      name: "a wider window (48 hours) admits the day before yesterday",
      input: {
        kind: "sick",
        fromDay: "2026-11-25",
        toDay: "2026-11-25",
        reason: "flu",
        settings: { ...settings, retroactiveHours: 48 },
      },
      retroactive: true,
    },
    {
      name: "travel cannot be retroactive",
      input: { kind: "travel", fromDay: "2026-11-26", toDay: "2026-11-26", reason: "trip" },
      code: "schedule.special_mode_not_retroactive",
    },
    {
      name: "a sick day from today needs no reason",
      input: { kind: "sick", fromDay: "2026-11-27", toDay: "2026-11-27" },
      retroactive: false,
    },
    {
      name: "holiday in the future",
      input: { kind: "holiday", fromDay: "2026-12-01", toDay: "2026-12-02" },
      retroactive: false,
    },
    {
      name: "exactly the quota is allowed",
      input: { kind: "holiday", fromDay: "2026-11-27", toDay: "2026-12-01" },
      retroactive: false,
    },
    {
      name: "one day over the quota is rejected",
      input: {
        kind: "holiday",
        fromDay: "2026-11-27",
        toDay: "2026-12-02",
        cycleFirstDays: ["2026-11-20"],
      },
      code: "schedule.special_mode_quota_exceeded",
    },
    {
      name: "a smaller configured quota applies",
      input: {
        kind: "holiday",
        fromDay: "2026-11-27",
        toDay: "2026-11-29",
        settings: { ...settings, daysPerCycle: 2 },
      },
      code: "schedule.special_mode_quota_exceeded",
    },
    {
      name: "a zero quota disables special modes",
      input: {
        kind: "sick",
        fromDay: "2026-11-27",
        toDay: "2026-11-27",
        settings: { ...settings, daysPerCycle: 0 },
      },
      code: "schedule.special_mode_quota_exceeded",
    },
    {
      name: "days already used count against the quota",
      input: {
        kind: "holiday",
        fromDay: "2026-12-10",
        toDay: "2026-12-12",
        existing: [{ fromDay: "2026-12-01", toDay: "2026-12-03" }],
      },
      code: "schedule.special_mode_quota_exceeded",
    },
    {
      name: "a period spanning two cycles is split by cycle day",
      input: {
        kind: "holiday",
        fromDay: "2026-11-28",
        toDay: "2026-12-02",
        cycleFirstDays: ["2026-11-02", "2026-11-30"],
      },
      retroactive: false,
    },
    {
      name: "days used in an earlier cycle do not count",
      input: {
        kind: "holiday",
        fromDay: "2026-11-30",
        toDay: "2026-12-04",
        cycleFirstDays: ["2026-11-02", "2026-11-30"],
        existing: [{ fromDay: "2026-11-10", toDay: "2026-11-14" }],
      },
      retroactive: false,
    },
    {
      name: "overlapping periods are rejected",
      input: {
        kind: "holiday",
        fromDay: "2026-12-02",
        toDay: "2026-12-03",
        existing: [{ fromDay: "2026-12-03", toDay: "2026-12-04" }],
      },
      code: "schedule.special_mode_overlap",
    },
    {
      name: "an inverted range is invalid",
      input: { kind: "holiday", fromDay: "2026-12-03", toDay: "2026-12-02" },
      code: "schedule.special_mode_invalid_range",
    },
  ];
  it.each(cases)("$name", ({ input, code, retroactive }) => {
    const r = planPeriod({ ...base, ...input } as Parameters<typeof planPeriod>[0]);
    if (code) expect(r).toEqual({ ok: false, code });
    else {
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.period.retroactive).toBe(retroactive);
    }
  });

  it("stores UTC instants of the local day boundaries", () => {
    const r = planPeriod({
      ...base,
      kind: "sick",
      fromDay: "2026-11-26",
      toDay: "2026-11-26",
      reason: "x",
    });
    expect(r.ok && [r.period.from, r.period.to]).toEqual([
      "2026-11-25T17:00:00.000Z",
      "2026-11-26T17:00:00.000Z",
    ]);
  });
});

function setup(values: Record<string, unknown> = {}) {
  const events: EventEnvelope[] = [];
  const t = { now: NOW };
  const appP = createApp(config, {
    now: () => t.now,
    readSettings: async () => values,
    publish: (e: EventEnvelope) => void events.push(e),
  });
  return { appP, events, t };
}
type App = Awaited<ReturnType<typeof setup>["appP"]>;

const fault = (id: string, occurredAt: string) => ({
  id: `fault-recorded-${id}`,
  type: "fault.recorded",
  occurredAt,
  userId: "u1",
  schemaVersion: 1,
  payload: { faultId: id, type: "wake_late", points: 10, occurredAt },
});
const sendLedger = (app: App, e: unknown) =>
  app.inject({ method: "POST", url: "/events/ledger", payload: e as object });
const activate = (app: App, payload: object) =>
  app.inject({ method: "POST", url: "/special-modes", headers: H, payload });

describe("special modes over HTTP", () => {
  it("waives faults of yesterday when a sick day is activated within 24 hours", async () => {
    const { appP, events } = setup();
    const app = await appP;
    await sendLedger(app, fault("f-yesterday", "2026-11-26T03:00:00Z"));
    await sendLedger(app, fault("f-today", "2026-11-27T00:30:00Z"));
    const res = await activate(app, {
      kind: "sick",
      fromDay: "2026-11-26",
      toDay: "2026-11-26",
      reason: "fever",
    });
    expect(res.statusCode).toBe(201);
    const { period } = res.json().data;
    expect(period.retroactive).toBe(true);
    expect(period.waivedFaults).toEqual([{ faultId: "f-yesterday", reason: "special_mode" }]);
    const started = events.filter((e) => e.type === "special_mode.started");
    expect(started).toHaveLength(1);
    expect(started[0]!.payload).toMatchObject({ kind: "sick", retroactive: true });
  });

  it("waives a fault that arrives after the period was activated", async () => {
    const { appP } = setup();
    const app = await appP;
    await activate(app, { kind: "sick", fromDay: "2026-11-27", toDay: "2026-11-27" });
    await sendLedger(app, fault("f-late", "2026-11-27T02:00:00Z"));
    const list = await app.inject({ method: "GET", url: "/special-modes", headers: H });
    expect(list.json().data.periods[0].waivedFaults).toEqual([
      { faultId: "f-late", reason: "special_mode" },
    ]);
  });

  it("does not waive faults outside the period", async () => {
    const { appP } = setup();
    const app = await appP;
    await sendLedger(app, fault("f-before", "2026-11-25T03:00:00Z"));
    const res = await activate(app, {
      kind: "sick",
      fromDay: "2026-11-26",
      toDay: "2026-11-26",
      reason: "x",
    });
    expect(res.json().data.period.waivedFaults).toEqual([]);
  });

  it("rejects a request beyond the window and publishes nothing", async () => {
    const { appP, events } = setup();
    const app = await appP;
    const res = await activate(app, {
      kind: "sick",
      fromDay: "2026-11-25",
      toDay: "2026-11-25",
      reason: "x",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("schedule.special_mode_window_exceeded");
    expect(events).toHaveLength(0);
  });

  it("reads the quota from the user's settings", async () => {
    const { appP } = setup({ "schedule.special_mode_days_per_cycle": 1 });
    const app = await appP;
    const res = await activate(app, {
      kind: "holiday",
      fromDay: "2026-12-01",
      toDay: "2026-12-02",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("schedule.special_mode_quota_exceeded");
  });

  it("rejects invalid bodies and a missing user", async () => {
    const { appP } = setup();
    const app = await appP;
    expect(
      (await activate(app, { kind: "nap", fromDay: "2026-12-01", toDay: "2026-12-01" })).statusCode,
    ).toBe(400);
    const anon = await app.inject({ method: "POST", url: "/special-modes", payload: {} });
    expect(anon.statusCode).toBe(401);
  });

  it("announces special_mode.ended once after the window passes", async () => {
    const { appP, events, t } = setup();
    const app = await appP;
    await activate(app, { kind: "holiday", fromDay: "2026-11-28", toDay: "2026-11-28" });
    const early = await app.inject({ method: "POST", url: "/jobs/special-modes" });
    expect(early.json().data.ended).toEqual([]);
    t.now = new Date("2026-11-29T00:00:00Z");
    await app.inject({ method: "POST", url: "/jobs/special-modes" });
    await app.inject({ method: "POST", url: "/jobs/special-modes" });
    expect(events.filter((e) => e.type === "special_mode.ended")).toHaveLength(1);
  });
});
