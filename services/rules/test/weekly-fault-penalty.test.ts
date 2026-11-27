import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import type { EventEnvelope, EventPayload } from "@my-wife/contracts";
import { createApp } from "../src/app";
import { InMemoryFaultStore, type FaultLedgerEntry } from "../src/fault";
import { InMemoryPenaltyStore, createPenaltyService } from "../src/penalty";
import { InMemoryTrialStore } from "../src/trial";
import {
  InMemoryWeeklyPenaltyStore,
  createWeeklyPenaltyService,
  weekWindow,
} from "../src/weekly-fault-penalty";
import type { WeeklyPenaltySettings } from "../src/weekly-penalty";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const WEEK1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const WEEK2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const NOW = new Date("2026-12-07T00:05:00.000Z");
const SETTINGS_TABLE: WeeklyPenaltySettings = {
  thresholds: [
    { points: 6, amountVnd: 20_000 },
    { points: 12, amountVnd: 50_000 },
  ],
  weeklyCapVnd: 60_000,
};

function ids() {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
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

function weekClosed(weekId: string, firstDay: string, userId = USER): EventEnvelope {
  return {
    id: `evt-${weekId}-${userId}`,
    type: "week.closed",
    userId,
    occurredAt: "2026-12-07T00:00:00.000Z",
    schemaVersion: 1,
    payload: { weekId, firstDay, weekIndexInCycle: 1 } satisfies EventPayload<"week.closed">,
  } as EventEnvelope;
}

function setup(opts: { settings?: WeeklyPenaltySettings; trialActive?: boolean } = {}) {
  const faultStore = new InMemoryFaultStore();
  const penaltyStore = new InMemoryPenaltyStore();
  const trialStore = new InMemoryTrialStore();
  const published: EventEnvelope[] = [];
  const newId = ids();
  const penalties = createPenaltyService({
    store: penaltyStore,
    trialStore: opts.trialActive
      ? ({
          find: () => ({ state: "active", endsAt: "2027-01-01T00:00:00.000Z" }),
          addSuspended: () => {},
        } as never)
      : trialStore,
    publish: (e) => void published.push(e),
    newId,
  });
  const weeklyStore = new InMemoryWeeklyPenaltyStore();
  const svc = createWeeklyPenaltyService({
    faultStore,
    weeklyStore,
    penalties,
    readSettings: async () => opts.settings ?? SETTINGS_TABLE,
    newId,
  });
  const addFaults = (list: FaultLedgerEntry[], userId = USER) =>
    list.forEach((f) =>
      faultStore.insertOnce(userId, f, { id: `a-${f.id}`, faultId: f.id } as never),
    );
  return { svc, faultStore, penaltyStore, weeklyStore, published, addFaults };
}

describe("weekWindow", () => {
  it("is seven UTC days from the first day", () => {
    const w = weekWindow("2026-11-30");
    expect(w.from.toISOString()).toBe("2026-11-30T00:00:00.000Z");
    expect(w.to.toISOString()).toBe("2026-12-07T00:00:00.000Z");
  });
});

describe("week.closed issues the weekly penalty (table)", () => {
  const cases = [
    { name: "below the first threshold", points: [3, 2], issued: 0 },
    { name: "exactly the first threshold", points: [3, 3], issued: 20_000 },
    { name: "between thresholds", points: [5, 4], issued: 20_000 },
    { name: "second threshold", points: [6, 6], issued: 50_000 },
    { name: "no faults", points: [], issued: 0 },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      const t = setup();
      t.addFaults(c.points.map((p, i) => fault(i + 1, `2026-12-01T0${i}:00:00.000Z`, p)));
      const r = await t.svc.onWeekClosed(weekClosed(WEEK1, "2026-11-30"), NOW);
      expect(r.issuedVnd).toBe(c.issued);
      const list = t.penaltyStore.list(USER);
      expect(list).toHaveLength(c.issued > 0 ? 1 : 0);
      if (c.issued > 0) {
        expect(list[0]).toMatchObject({
          source: "monitoring",
          amountVnd: c.issued,
          status: "due",
        });
        expect(t.published.map((e) => e.type)).toEqual(["penalty.issued"]);
      } else {
        expect(t.published).toEqual([]);
      }
    });
  }
});

describe("which faults count", () => {
  it("counts only recorded faults inside the week, of this user", async () => {
    const t = setup();
    t.addFaults([
      fault(1, "2026-12-01T10:00:00.000Z", 3),
      fault(2, "2026-12-02T10:00:00.000Z", 3, "waived_system"),
      fault(3, "2026-12-02T11:00:00.000Z", 3, "waived_card"),
      fault(4, "2026-12-02T12:00:00.000Z", 3, "overturned"),
      fault(5, "2026-12-02T13:00:00.000Z", 3, "pending_reason"),
      fault(6, "2026-12-02T14:00:00.000Z", 3, "appealed"),
      fault(7, "2026-11-29T23:59:59.000Z", 3),
      fault(8, "2026-12-07T00:00:00.000Z", 3),
    ]);
    t.addFaults([fault(9, "2026-12-01T10:00:00.000Z", 9)], OTHER);
    const r = await t.svc.onWeekClosed(weekClosed(WEEK1, "2026-11-30"), NOW);
    expect(r.points).toBe(3);
    expect(r.issuedVnd).toBe(0);
  });

  it("includes a fault on the first instant and excludes the end instant", async () => {
    const t = setup();
    t.addFaults([
      fault(1, "2026-11-30T00:00:00.000Z", 3),
      fault(2, "2026-12-06T23:59:59.999Z", 3),
      fault(3, "2026-12-07T00:00:00.000Z", 9),
    ]);
    const r = await t.svc.onWeekClosed(weekClosed(WEEK1, "2026-11-30"), NOW);
    expect(r.points).toBe(6);
    expect(r.issuedVnd).toBe(20_000);
  });
});

describe("cap and carry-over across weeks", () => {
  it("carries the excess into the next week", async () => {
    const t = setup({ settings: { ...SETTINGS_TABLE, weeklyCapVnd: 30_000 } });
    t.addFaults([fault(1, "2026-12-01T10:00:00.000Z", 12)]);
    const w1 = await t.svc.onWeekClosed(weekClosed(WEEK1, "2026-11-30"), NOW);
    expect(w1).toMatchObject({ rawPenaltyVnd: 50_000, issuedVnd: 30_000, carryOutVnd: 20_000 });
    t.addFaults([fault(2, "2026-12-08T10:00:00.000Z", 6)]);
    const w2 = await t.svc.onWeekClosed(weekClosed(WEEK2, "2026-12-07"), NOW);
    expect(w2).toMatchObject({
      carriedInVnd: 20_000,
      rawPenaltyVnd: 20_000,
      issuedVnd: 30_000,
      carryOutVnd: 10_000,
    });
    expect(t.penaltyStore.list(USER).map((p) => p.amountVnd)).toEqual([30_000, 30_000]);
  });

  it("pays carried debt in a clean week", async () => {
    const t = setup({ settings: { ...SETTINGS_TABLE, weeklyCapVnd: 30_000 } });
    t.addFaults([fault(1, "2026-12-01T10:00:00.000Z", 12)]);
    await t.svc.onWeekClosed(weekClosed(WEEK1, "2026-11-30"), NOW);
    const w2 = await t.svc.onWeekClosed(weekClosed(WEEK2, "2026-12-07"), NOW);
    expect(w2).toMatchObject({ points: 0, issuedVnd: 20_000, carryOutVnd: 0 });
  });

  it("does not mix carried debt between users", async () => {
    const t = setup({ settings: { ...SETTINGS_TABLE, weeklyCapVnd: 30_000 } });
    t.addFaults([fault(1, "2026-12-01T10:00:00.000Z", 12)]);
    await t.svc.onWeekClosed(weekClosed(WEEK1, "2026-11-30"), NOW);
    const other = await t.svc.onWeekClosed(weekClosed(WEEK1, "2026-11-30", OTHER), NOW);
    expect(other.carriedInVnd).toBe(0);
  });
});

describe("idempotency per week", () => {
  it("a redelivered week.closed issues nothing new", async () => {
    const t = setup();
    t.addFaults([fault(1, "2026-12-01T10:00:00.000Z", 6)]);
    const first = await t.svc.onWeekClosed(weekClosed(WEEK1, "2026-11-30"), NOW);
    t.addFaults([fault(2, "2026-12-02T10:00:00.000Z", 9)]);
    const again = await t.svc.onWeekClosed(weekClosed(WEEK1, "2026-11-30"), NOW);
    expect(again).toEqual({ ...first, duplicate: true });
    expect(t.penaltyStore.list(USER)).toHaveLength(1);
    expect(t.published).toHaveLength(1);
    expect(t.weeklyStore.list(USER)).toHaveLength(1);
  });

  it("re-publishes an owed event after a failed publish, without a second entry", async () => {
    const t = setup();
    let fail = true;
    const penalties = createPenaltyService({
      store: t.penaltyStore,
      trialStore: new InMemoryTrialStore(),
      publish: (e) => {
        if (fail) throw new Error("bus down");
        t.published.push(e);
      },
      newId: ids(),
    });
    const svc = createWeeklyPenaltyService({
      faultStore: t.faultStore,
      weeklyStore: t.weeklyStore,
      penalties,
      readSettings: async () => SETTINGS_TABLE,
    });
    t.addFaults([fault(1, "2026-12-01T10:00:00.000Z", 6)]);
    await svc.onWeekClosed(weekClosed(WEEK1, "2026-11-30"), NOW);
    expect(t.published).toHaveLength(0);
    fail = false;
    await svc.onWeekClosed(weekClosed(WEEK1, "2026-11-30"), NOW);
    expect(t.published.map((e) => e.type)).toEqual(["penalty.issued"]);
    expect(t.penaltyStore.list(USER)).toHaveLength(1);
  });
});

describe("audit trail and trial", () => {
  it("stores the computation inputs and links the audit to the entry", async () => {
    const t = setup();
    t.addFaults([fault(1, "2026-12-01T10:00:00.000Z", 6)]);
    await t.svc.onWeekClosed(weekClosed(WEEK1, "2026-11-30"), NOW);
    const rec = t.weeklyStore.list(USER)[0]!;
    expect(rec).toMatchObject({
      weekId: WEEK1,
      firstDay: "2026-11-30",
      points: 6,
      faultIds: [fault(1, "", 0).id],
      thresholds: SETTINGS_TABLE.thresholds,
      weeklyCapVnd: 60_000,
      computedAt: NOW.toISOString(),
    });
    const entry = t.penaltyStore.list(USER)[0]!;
    expect(rec.penaltyId).toBe(entry.id);
    const audit = t.penaltyStore.audit(USER);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "penalty.created", penaltyId: entry.id });
    expect(audit[0]!.detail).toMatchObject({
      sourceEventId: `evt-${WEEK1}-${USER}`,
      points: 6,
    });
    expect(entry.auditRefs).toEqual([audit[0]!.id]);
  });

  it("suspends the penalty during the trial", async () => {
    const t = setup({ trialActive: true });
    t.addFaults([fault(1, "2026-12-01T10:00:00.000Z", 6)]);
    await t.svc.onWeekClosed(weekClosed(WEEK1, "2026-11-30"), NOW);
    expect(t.penaltyStore.list(USER)[0]!.status).toBe("suspended");
    expect(t.published.map((e) => e.type)).toEqual(["penalty.suspended"]);
  });

  it("falls back to the registry defaults when no settings reader is given", async () => {
    const penalties = createPenaltyService({
      store: new InMemoryPenaltyStore(),
      trialStore: new InMemoryTrialStore(),
    });
    const svc = createWeeklyPenaltyService({
      faultStore: new InMemoryFaultStore(),
      weeklyStore: new InMemoryWeeklyPenaltyStore(),
      penalties,
    });
    const r = await svc.onWeekClosed(weekClosed(WEEK1, "2026-11-30"), NOW);
    expect(r.issuedVnd).toBe(0);
  });
});

describe("POST /events/week-closed", () => {
  const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });

  it("rejects an event of another type", async () => {
    const app = createApp(config, {});
    const res = await app.inject({
      method: "POST",
      url: "/events/week-closed",
      payload: { ...weekClosed(WEEK1, "2026-11-30"), type: "week.planned" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("issues the penalty through the app and answers the same on redelivery", async () => {
    const faultStore = new InMemoryFaultStore();
    const penaltyStore = new InMemoryPenaltyStore();
    const published: EventEnvelope[] = [];
    faultStore.insertOnce(USER, fault(1, "2026-12-01T10:00:00.000Z", 6), { id: "a1" } as never);
    const app = createApp(config, {
      faultStore,
      penaltyStore,
      publish: (e) => void published.push(e),
      now: () => NOW,
      readWeeklyPenaltySettings: async () => SETTINGS_TABLE,
    });
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/events/week-closed",
        payload: weekClosed(WEEK1, "2026-11-30"),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ issuedVnd: 20_000 });
    }
    expect(penaltyStore.list(USER)).toHaveLength(1);
    expect(published.map((e) => e.type)).toEqual(["penalty.issued"]);
  });
});
