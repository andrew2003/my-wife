import { describe, expect, it } from "vitest";
import { SETTINGS, type EventEnvelope } from "@my-wife/contracts";
import {
  DEFAULT_PENALTY_SETTINGS,
  InMemoryPenaltyStore,
  computeOverspendPenalty,
  createPenaltyService,
  type PenaltySettings,
} from "../src/penalty";
import { InMemoryTrialStore, type TrialRecord } from "../src/trial";

const USER = "11111111-1111-4111-8111-111111111111";
const CYCLE = "22222222-2222-4222-8222-222222222222";
const CAT = "55555555-5555-4555-8555-555555555555";
const T0 = new Date("2026-11-26T03:00:00.000Z");
const WEEK = 7 * 24 * 3_600_000;

function ids() {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
}

describe("DEFAULT_PENALTY_SETTINGS", () => {
  it("is read from the settings registry", () => {
    expect(DEFAULT_PENALTY_SETTINGS.needMode).toBe(SETTINGS["penalty.need_overspend_mode"].default);
    expect(DEFAULT_PENALTY_SETTINGS.overspendPercent).toBe(
      SETTINGS["penalty.overspend_percent"].default,
    );
  });
});

const base = { weeklyLimitVnd: 200_000, spentVnd: 250_000 };
const settings = (p: Partial<PenaltySettings> = {}): PenaltySettings => ({
  ...DEFAULT_PENALTY_SETTINGS,
  ...p,
});
const full = (excessVnd: number, penaltyVnd: number, warnOnly = false) => ({
  excessVnd,
  penaltyVnd,
  limitDeductionVnd: penaltyVnd,
  warnOnly,
});

describe("computeOverspendPenalty (table)", () => {
  const cases = [
    {
      name: "want, default 100 percent",
      priority: "want",
      excessVnd: 50_000,
      s: settings(),
      expected: full(50_000, 50_000),
    },
    {
      name: "want, 50 percent",
      priority: "want",
      excessVnd: 50_000,
      s: settings({ overspendPercent: 50 }),
      expected: full(50_000, 25_000),
    },
    {
      name: "rounds half up in integer VND",
      priority: "should",
      excessVnd: 1_001,
      s: settings({ overspendPercent: 50 }),
      expected: full(1_001, 501),
    },
    {
      name: "one VND over at 100 percent",
      priority: "want",
      excessVnd: 1,
      s: settings(),
      expected: full(1, 1),
    },
    {
      name: "zero excess gives nothing",
      priority: "want",
      excessVnd: 0,
      s: settings(),
      expected: full(0, 0),
    },
    {
      name: "need + penalize is computed like other groups",
      priority: "need",
      excessVnd: 50_000,
      s: settings({ needMode: "penalize" }),
      expected: full(50_000, 50_000),
    },
    {
      name: "need + warn_only gives a warning and no penalty",
      priority: "need",
      excessVnd: 50_000,
      s: settings({ needMode: "warn_only" }),
      expected: full(50_000, 0, true),
    },
    {
      name: "warn_only does not affect want",
      priority: "want",
      excessVnd: 50_000,
      s: settings({ needMode: "warn_only" }),
      expected: full(50_000, 50_000),
    },
    {
      name: "invalid percent falls back to the default",
      priority: "want",
      excessVnd: 10_000,
      s: settings({ overspendPercent: -5 }),
      expected: full(10_000, 10_000),
    },
  ] as const;
  it.each(cases)("$name", ({ priority, excessVnd, s, expected }) => {
    expect(computeOverspendPenalty({ priority, ...base, excessVnd }, s)).toEqual(expected);
  });
});

function overspend(priority: string, excessVnd = 50_000, id = "evt-1"): EventEnvelope {
  return {
    id,
    type: "overspend.detected",
    userId: USER,
    occurredAt: T0.toISOString(),
    schemaVersion: 1,
    payload: {
      cycleId: CYCLE,
      weekIndex: 2,
      categoryId: CAT,
      priority,
      weeklyLimitVnd: 200_000,
      spentVnd: 200_000 + excessVnd,
      excessVnd,
    },
  } as EventEnvelope;
}

function trialRecord(over: Partial<TrialRecord> = {}): TrialRecord {
  return {
    userId: USER,
    settings: { weeks: 4, installmentsK: 1, finalAppealHours: 72 },
    startedAt: T0.toISOString(),
    endsAt: new Date(T0.getTime() + 4 * WEEK).toISOString(),
    state: "active",
    startedPublished: true,
    endedPublished: false,
    settledPublished: false,
    ...over,
  };
}

function setup(opts: { trial?: TrialRecord; settings?: Partial<PenaltySettings> } = {}) {
  const events: EventEnvelope[] = [];
  const trialStore = new InMemoryTrialStore();
  if (opts.trial) trialStore.create(opts.trial);
  const store = new InMemoryPenaltyStore();
  const service = createPenaltyService({
    store,
    trialStore,
    publish: (e) => void events.push(e),
    newId: ids(),
    readSettings: async () => settings(opts.settings),
  });
  return { events, store, trialStore, service };
}

describe("onOverspendDetected", () => {
  it("in trial: suspended entry, penalty.suspended, no payment request", async () => {
    const { events, store, trialStore, service } = setup({ trial: trialRecord() });
    const r = await service.onOverspendDetected(overspend("want"), T0);
    expect(r).toMatchObject({ status: "suspended", amountVnd: 50_000, duplicate: false });
    expect(events.map((e) => e.type)).toEqual(["penalty.suspended"]);
    expect(store.list(USER)[0]).toMatchObject({ source: "overspend", status: "suspended" });
    expect(trialStore.suspended(USER)).toHaveLength(1);
    expect(store.audit(USER)).toHaveLength(1);
  });

  it("trial over (final appeal or settled): issued as due", async () => {
    for (const state of ["final_appeal", "settled"] as const) {
      const { events, store, service } = setup({ trial: trialRecord({ state }) });
      await service.onOverspendDetected(overspend("want"), T0);
      expect(events.map((e) => e.type)).toEqual(["penalty.issued"]);
      expect(store.list(USER)[0]).toMatchObject({ status: "due" });
    }
  });

  it("active trial whose end time has passed counts as over", async () => {
    const { events, service } = setup({ trial: trialRecord() });
    await service.onOverspendDetected(overspend("want"), new Date(T0.getTime() + 4 * WEEK));
    expect(events.map((e) => e.type)).toEqual(["penalty.issued"]);
  });

  it("no trial: penalty.issued with transfer code, due date and amount", async () => {
    const { events, service } = setup();
    await service.onOverspendDetected(overspend("want"), T0);
    const e = events[0]!;
    expect(e.type).toBe("penalty.issued");
    expect(e.payload).toMatchObject({ source: "overspend", amountVnd: 50_000 });
    const p = e.payload as { transferCode: string; dueDate: string };
    expect(p.transferCode).toMatch(/^MW-PH-/);
    expect(Date.parse(p.dueDate)).toBeGreaterThan(T0.getTime());
  });

  it("need + warn_only (from settings): no entry, no event", async () => {
    const { events, store, service } = setup({ settings: { needMode: "warn_only" } });
    const r = await service.onOverspendDetected(overspend("need"), T0);
    expect(r).toMatchObject({ status: "none", warnOnly: true });
    expect(events).toEqual([]);
    expect(store.list(USER)).toEqual([]);
  });

  it("need + penalize (from settings): penalized with the configured percent", async () => {
    const { events, store, service } = setup({
      settings: { needMode: "penalize", overspendPercent: 40 },
    });
    await service.onOverspendDetected(overspend("need", 50_000), T0);
    expect(events[0]!.type).toBe("penalty.issued");
    expect(store.list(USER)[0]!.amountVnd).toBe(20_000);
  });

  it("zero excess creates nothing", async () => {
    const { events, store, service } = setup();
    await service.onOverspendDetected(overspend("want", 0), T0);
    expect(events).toEqual([]);
    expect(store.list(USER)).toEqual([]);
  });

  it("redelivery creates one entry and one event", async () => {
    const { events, store, service } = setup();
    await service.onOverspendDetected(overspend("want"), T0);
    const again = await service.onOverspendDetected(overspend("want", 50_000, "evt-2"), T0);
    expect(again.duplicate).toBe(true);
    expect(store.list(USER)).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it("a failed publish is retried by the next delivery without a second entry", async () => {
    const events: EventEnvelope[] = [];
    let fail = true;
    const store = new InMemoryPenaltyStore();
    const service = createPenaltyService({
      store,
      trialStore: new InMemoryTrialStore(),
      publish: (e) => {
        if (fail) throw new Error("bus down");
        events.push(e);
      },
      newId: ids(),
    });
    await service.onOverspendDetected(overspend("want"), T0);
    expect(events).toEqual([]);
    fail = false;
    await service.onOverspendDetected(overspend("want"), T0);
    expect(events).toHaveLength(1);
    expect(store.list(USER)).toHaveLength(1);
  });
});
