import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import type { EventEnvelope, EventPayload } from "@my-wife/contracts";
import { createApp } from "../src/app";
import { InMemoryFaultStore, type FaultLedgerEntry } from "../src/fault";
import {
  DEFAULT_REWARD_SETTINGS,
  InMemoryRewardStore,
  createRewardService,
  evaluateReward,
  type RewardSettings,
} from "../src/reward";

const USER = "11111111-1111-4111-8111-111111111111";
const CATEGORY = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-12-07T00:05:00.000Z");

function weekClosed(n: number, firstDay: string, userId = USER): EventEnvelope {
  const weekId = `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
  return {
    id: `evt-${weekId}`,
    type: "week.closed",
    userId,
    occurredAt: "2026-12-07T00:00:00.000Z",
    schemaVersion: 1,
    payload: { weekId, firstDay, weekIndexInCycle: 1 } satisfies EventPayload<"week.closed">,
  } as EventEnvelope;
}

function fault(
  n: number,
  occurredAt: string,
  points: number,
  status: FaultLedgerEntry["status"] = "recorded",
): FaultLedgerEntry {
  return {
    id: `f0000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    type: "no_face",
    occurredAt,
    signalRef: `sig-${n}`,
    reasonRef: null,
    weightSnapshot: 2,
    points,
    status,
    waiver: null,
    systemCause: null,
    honestReason: false,
  };
}

function setup(settings: RewardSettings = DEFAULT_REWARD_SETTINGS) {
  const faultStore = new InMemoryFaultStore();
  const published: EventEnvelope[] = [];
  let failPublish = false;
  const svc = createRewardService({
    faultStore,
    store: new InMemoryRewardStore(),
    readSettings: async () => settings,
    publish: (e) => {
      if (failPublish) throw new Error("bus down");
      published.push(e);
    },
  });
  const addFaults = (list: FaultLedgerEntry[], userId = USER) =>
    list.forEach((f) =>
      faultStore.insertOnce(userId, f, { id: `a-${f.id}`, faultId: f.id } as never),
    );
  return { svc, published, addFaults, failNext: (v: boolean) => (failPublish = v) };
}

describe("evaluateReward (table)", () => {
  const cases = [
    {
      name: "clean week reaches the 7-day streak",
      clean: true,
      prior: 0,
      streak: 7,
      unlock: true,
      next: 0,
    },
    {
      name: "week with points resets the streak",
      clean: false,
      prior: 1,
      streak: 7,
      unlock: false,
      next: 0,
    },
    {
      name: "two-week streak: first clean week",
      clean: true,
      prior: 0,
      streak: 14,
      unlock: false,
      next: 1,
    },
    {
      name: "two-week streak: second clean week",
      clean: true,
      prior: 1,
      streak: 14,
      unlock: true,
      next: 0,
    },
    {
      name: "streak of 8 days needs two weeks",
      clean: true,
      prior: 0,
      streak: 8,
      unlock: false,
      next: 1,
    },
    {
      name: "streak shorter than a week is met by one",
      clean: true,
      prior: 0,
      streak: 3,
      unlock: true,
      next: 0,
    },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const r = evaluateReward({
        clean: c.clean,
        priorCleanWeeks: c.prior,
        settings: { ...DEFAULT_REWARD_SETTINGS, cleanStreakDays: c.streak },
      });
      expect(r).toEqual({ unlock: c.unlock, cleanWeeks: c.next });
    });
  }
});

describe("POST /events/week-closed-reward", () => {
  it("emits reward.unlocked for a clean week and rejects other events", async () => {
    const published: EventEnvelope[] = [];
    const app = createApp(loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" }), {
      publish: (e) => void published.push(e),
      now: () => NOW,
    });
    const ok = await app.inject({
      method: "POST",
      url: "/events/week-closed-reward",
      payload: weekClosed(1, "2026-11-30"),
    });
    expect(ok.statusCode).toBe(200);
    expect(published.map((e) => e.type)).toEqual(["reward.unlocked"]);
    const bad = await app.inject({
      method: "POST",
      url: "/events/week-closed-reward",
      payload: { ...weekClosed(2, "2026-11-30"), type: "fault.detected" },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe("week.closed reward", () => {
  it("emits reward.unlocked for a clean week with the configured amount", async () => {
    const t = setup({ cleanStreakDays: 7, unlockAmountVnd: 80_000, categoryId: CATEGORY });
    const r = await t.svc.onWeekClosed(weekClosed(1, "2026-11-30"), NOW);
    expect(r).toMatchObject({ clean: true, unlocked: true, duplicate: false });
    expect(t.published).toHaveLength(1);
    expect(t.published[0]).toMatchObject({
      type: "reward.unlocked",
      userId: USER,
      payload: { amountVnd: 80_000, categoryId: CATEGORY },
    });
  });

  it("uses the registry defaults and the penalty fund (null category) when unset", async () => {
    const t = setup();
    await t.svc.onWeekClosed(weekClosed(1, "2026-11-30"), NOW);
    expect(t.published[0]!.payload).toEqual({ amountVnd: 50_000, categoryId: null });
  });

  it("emits nothing when the week has recorded points", async () => {
    const t = setup();
    t.addFaults([fault(1, "2026-12-01T10:00:00.000Z", 1)]);
    const r = await t.svc.onWeekClosed(weekClosed(1, "2026-11-30"), NOW);
    expect(r).toMatchObject({ clean: false, unlocked: false });
    expect(t.published).toEqual([]);
  });

  it("ignores waived, overturned, other-week and other-user faults", async () => {
    const t = setup();
    t.addFaults([
      fault(1, "2026-12-01T10:00:00.000Z", 3, "waived_system"),
      fault(2, "2026-12-02T10:00:00.000Z", 3, "overturned"),
      fault(3, "2026-12-08T10:00:00.000Z", 3),
    ]);
    t.addFaults([fault(4, "2026-12-01T10:00:00.000Z", 3)], "22222222-2222-4222-8222-222222222222");
    const r = await t.svc.onWeekClosed(weekClosed(1, "2026-11-30"), NOW);
    expect(r.unlocked).toBe(true);
  });

  it.each([
    ["recorded", false],
    ["appealed", false],
    ["upheld", false],
    ["pending_reason", false],
    ["waived_system", true],
    ["waived_card", true],
    ["overturned", true],
    ["expired", true],
  ] as const)("a fault with status %s makes the week clean: %s", async (status, clean) => {
    const t = setup();
    t.addFaults([fault(1, "2026-12-01T10:00:00.000Z", 3, status)]);
    const r = await t.svc.onWeekClosed(weekClosed(1, "2026-11-30"), NOW);
    expect(r.clean).toBe(clean);
    expect(r.unlocked).toBe(clean);
  });

  it("a redelivery does not emit twice, and a failed publish is retried", async () => {
    const t = setup();
    t.failNext(true);
    const ev = weekClosed(1, "2026-11-30");
    await t.svc.onWeekClosed(ev, NOW);
    expect(t.published).toEqual([]);
    t.failNext(false);
    const again = await t.svc.onWeekClosed(ev, NOW);
    expect(again.duplicate).toBe(true);
    expect(t.published).toHaveLength(1);
    await t.svc.onWeekClosed(ev, NOW);
    expect(t.published).toHaveLength(1);
  });

  it("a multi-week streak unlocks once, then starts again", async () => {
    const t = setup({ ...DEFAULT_REWARD_SETTINGS, cleanStreakDays: 14 });
    const days = ["2026-11-16", "2026-11-23", "2026-11-30", "2026-12-07"];
    const counts: number[] = [];
    for (const [i, d] of days.entries()) {
      await t.svc.onWeekClosed(weekClosed(i + 1, d), NOW);
      counts.push(t.published.length);
    }
    expect(counts).toEqual([0, 1, 1, 2]);
  });

  it("a dirty week in the middle breaks the streak", async () => {
    const t = setup({ ...DEFAULT_REWARD_SETTINGS, cleanStreakDays: 14 });
    t.addFaults([fault(1, "2026-11-24T10:00:00.000Z", 2)]);
    await t.svc.onWeekClosed(weekClosed(1, "2026-11-16"), NOW);
    await t.svc.onWeekClosed(weekClosed(2, "2026-11-23"), NOW);
    await t.svc.onWeekClosed(weekClosed(3, "2026-11-30"), NOW);
    expect(t.published).toEqual([]);
  });

  it("a skipped week breaks the streak", async () => {
    const t = setup({ ...DEFAULT_REWARD_SETTINGS, cleanStreakDays: 14 });
    await t.svc.onWeekClosed(weekClosed(1, "2026-11-16"), NOW);
    await t.svc.onWeekClosed(weekClosed(2, "2026-11-30"), NOW);
    expect(t.published).toEqual([]);
  });
});
