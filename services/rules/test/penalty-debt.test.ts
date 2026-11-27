import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "@my-wife/contracts";
import { InMemoryPenaltyStore, createPenaltyService } from "../src/penalty";
import { InMemoryPenaltyDebtStore, type WantLimit } from "../src/penalty-source";
import { InMemoryTrialStore } from "../src/trial";

const USER = "11111111-1111-4111-8111-111111111111";
const CYCLE = "22222222-2222-4222-8222-222222222222";
const CAT = "55555555-5555-4555-8555-555555555555";
const ACCOUNT = "66666666-6666-4666-8666-666666666666";
const TX = "77777777-7777-4777-8777-777777777777";
const NOW = new Date("2026-11-27T03:00:00.000Z");

function ids() {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
}

function overspend(weekIndex: number, excessVnd: number): EventEnvelope {
  return {
    id: `evt-${weekIndex}`,
    type: "overspend.detected",
    userId: USER,
    occurredAt: NOW.toISOString(),
    schemaVersion: 1,
    payload: {
      cycleId: CYCLE,
      weekIndex,
      categoryId: CAT,
      priority: "want",
      weeklyLimitVnd: 200_000,
      spentVnd: 200_000 + excessVnd,
      excessVnd,
    },
  } as EventEnvelope;
}

function withdrawal(
  amountVnd: number,
  o: { transactionId?: string | null; id?: string } = {},
): EventEnvelope {
  return {
    id: o.id ?? "evt-w1",
    type: "penalty_savings.withdrawal_detected",
    userId: USER,
    occurredAt: NOW.toISOString(),
    schemaVersion: 1,
    payload: {
      bankAccountId: ACCOUNT,
      amountVnd,
      transactionId: o.transactionId === undefined ? TX : o.transactionId,
      detectedBy: "receipt",
    },
  } as EventEnvelope;
}

function setup(opts: { wants?: WantLimit[]; order?: string[]; inTrial?: boolean } = {}) {
  const store = new InMemoryPenaltyStore();
  const debtStore = new InMemoryPenaltyDebtStore();
  const trialStore = new InMemoryTrialStore();
  const published: EventEnvelope[] = [];
  let wants = opts.wants ?? [];
  const service = createPenaltyService({
    store,
    trialStore,
    debtStore,
    newId: ids(),
    publish: (e) => void published.push(e),
    readWantList: async () => wants,
    readSettings: async () => ({
      needMode: "penalize",
      overspendPercent: 100,
      wantDeductionOrder: opts.order ?? [],
      withdrawalExtraPercent: 20,
    }),
  });
  return {
    store,
    debtStore,
    trialStore,
    published,
    service,
    setWants: (w: WantLimit[]) => (wants = w),
  };
}

describe("penalty source exhaustion", () => {
  it("covers the penalty from the want list and carries no debt", async () => {
    const t = setup({ wants: [{ categoryId: "a", remainingLimitVnd: 100_000 }] });
    await t.service.onOverspendDetected(overspend(1, 60_000), NOW);
    expect(t.debtStore.balance(USER)).toBe(0);
    expect(t.debtStore.list(USER)[0]?.deductions).toEqual([{ categoryId: "a", amountVnd: 60_000 }]);
  });

  it("turns the shortfall into penalty debt carried over", async () => {
    const t = setup({
      wants: [
        { categoryId: "a", remainingLimitVnd: 30_000 },
        { categoryId: "b", remainingLimitVnd: 10_000 },
      ],
    });
    await t.service.onOverspendDetected(overspend(1, 100_000), NOW);
    expect(t.debtStore.balance(USER)).toBe(60_000);
    expect(t.debtStore.list(USER)[0]).toMatchObject({ penaltyVnd: 100_000, shortfallVnd: 60_000 });
    // The ledger entry itself is unchanged: the user still owes the full penalty.
    expect(t.store.list(USER)[0]?.amountVnd).toBe(100_000);
  });

  it("adds carried debt to the next penalty and clears it when the list covers both", async () => {
    const t = setup({ wants: [{ categoryId: "a", remainingLimitVnd: 10_000 }] });
    await t.service.onOverspendDetected(overspend(1, 50_000), NOW);
    expect(t.debtStore.balance(USER)).toBe(40_000);
    t.setWants([{ categoryId: "a", remainingLimitVnd: 100_000 }]);
    await t.service.onOverspendDetected(overspend(2, 20_000), NOW);
    const second = t.debtStore.list(USER)[1];
    expect(second).toMatchObject({ carriedInVnd: 40_000, shortfallVnd: 0 });
    expect(second?.deductions).toEqual([{ categoryId: "a", amountVnd: 60_000 }]);
    expect(t.debtStore.balance(USER)).toBe(0);
  });

  it("is idempotent on a repeated event", async () => {
    const t = setup({ wants: [] });
    await t.service.onOverspendDetected(overspend(1, 50_000), NOW);
    await t.service.onOverspendDetected(overspend(1, 50_000), NOW);
    expect(t.debtStore.list(USER)).toHaveLength(1);
    expect(t.debtStore.balance(USER)).toBe(50_000);
  });

  it("uses the configured deduction order", async () => {
    const t = setup({
      order: ["b", "a"],
      wants: [
        { categoryId: "a", remainingLimitVnd: 100_000 },
        { categoryId: "b", remainingLimitVnd: 100_000 },
      ],
    });
    await t.service.onOverspendDetected(overspend(1, 30_000), NOW);
    expect(t.debtStore.list(USER)[0]?.deductions).toEqual([{ categoryId: "b", amountVnd: 30_000 }]);
  });

  it("records no debt when no want list reader is configured", async () => {
    const store = new InMemoryPenaltyStore();
    const debtStore = new InMemoryPenaltyDebtStore();
    const service = createPenaltyService({
      store,
      trialStore: new InMemoryTrialStore(),
      debtStore,
      newId: ids(),
    });
    await service.onOverspendDetected(overspend(1, 50_000), NOW);
    expect(debtStore.list(USER)).toHaveLength(0);
  });
});

describe("penalty savings withdrawal", () => {
  it("issues a flagged withdrawal penalty: repayment plus the extra percent", async () => {
    const t = setup();
    const r = await t.service.onWithdrawalDetected(withdrawal(1_000_000), NOW);
    expect(r).toMatchObject({ status: "due", amountVnd: 1_200_000, duplicate: false });
    const e = t.store.list(USER)[0]!;
    expect(e).toMatchObject({ source: "withdrawal", amountVnd: 1_200_000, status: "due" });
    expect(e.flagged).toBe(true);
    expect(e.transferCode.startsWith("MW-PH-")).toBe(true);
    const audit = t.store.audit(USER)[0]!;
    expect(audit.detail).toMatchObject({
      flagged: true,
      repaymentVnd: 1_000_000,
      extraVnd: 200_000,
      extraPercent: 20,
      detectedBy: "receipt",
      transactionId: TX,
    });
    expect(t.published.map((e) => e.type)).toEqual(["penalty.issued"]);
    expect(t.published[0]?.payload).toMatchObject({ source: "withdrawal", amountVnd: 1_200_000 });
  });

  it("uses the user's extra percent setting", async () => {
    const store = new InMemoryPenaltyStore();
    const service = createPenaltyService({
      store,
      trialStore: new InMemoryTrialStore(),
      newId: ids(),
      readSettings: async () => ({
        needMode: "penalize",
        overspendPercent: 100,
        withdrawalExtraPercent: 50,
      }),
    });
    await service.onWithdrawalDetected(withdrawal(100_000), NOW);
    expect(store.list(USER)[0]?.amountVnd).toBe(150_000);
  });

  it("is idempotent per transaction and distinguishes transactions", async () => {
    const t = setup();
    await t.service.onWithdrawalDetected(withdrawal(100_000), NOW);
    const again = await t.service.onWithdrawalDetected(withdrawal(100_000, { id: "evt-w2" }), NOW);
    expect(again.duplicate).toBe(true);
    expect(t.store.list(USER)).toHaveLength(1);
    await t.service.onWithdrawalDetected(
      withdrawal(100_000, { transactionId: "88888888-8888-4888-8888-888888888888" }),
      NOW,
    );
    expect(t.store.list(USER)).toHaveLength(2);
    expect(new Set(t.store.list(USER).map((e) => e.transferCode)).size).toBe(2);
  });

  it("keys a reconciliation detection without a transaction by event id", async () => {
    const t = setup();
    await t.service.onWithdrawalDetected(
      withdrawal(80_000, { transactionId: null, id: "e1" }),
      NOW,
    );
    await t.service.onWithdrawalDetected(
      withdrawal(80_000, { transactionId: null, id: "e2" }),
      NOW,
    );
    expect(t.store.list(USER)).toHaveLength(2);
  });

  it("ignores a zero amount", async () => {
    const t = setup();
    const r = await t.service.onWithdrawalDetected(withdrawal(0), NOW);
    expect(r.status).toBe("none");
    expect(t.store.list(USER)).toHaveLength(0);
  });

  it("is suspended during the trial like any penalty, with no payment request", async () => {
    const t = setup();
    t.trialStore.create({
      userId: USER,
      settings: {} as never,
      startedAt: NOW.toISOString(),
      endsAt: new Date(NOW.getTime() + 86_400_000).toISOString(),
      state: "active",
      startedPublished: true,
      endedPublished: false,
      settledPublished: false,
    });
    const r = await t.service.onWithdrawalDetected(withdrawal(100_000), NOW);
    expect(r.status).toBe("suspended");
    expect(t.published.map((e) => e.type)).toEqual(["penalty.suspended"]);
  });

  it("is not allocated to the want list and creates no debt", async () => {
    const t = setup({ wants: [{ categoryId: "a", remainingLimitVnd: 1 }] });
    await t.service.onWithdrawalDetected(withdrawal(100_000), NOW);
    expect(t.debtStore.list(USER)).toHaveLength(0);
  });
});
