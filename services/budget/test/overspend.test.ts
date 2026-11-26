import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "@my-wife/contracts";
import { createOnboardingHandler, MemorySampleBudgetStore } from "../src/onboarding";
import { createTransactionHandler } from "../src/transactions";
import { createWeekClosedHandler, detectOverspends, effectiveWeeklyLimit } from "../src/overspend";

const NOW = new Date("2026-03-05T10:00:00Z");
const CLOSE = new Date("2026-03-09T00:00:01Z");
const FIRST_DAY = "2026-03-02";

describe("detectOverspends (pure)", () => {
  const base = {
    categoryId: "c1",
    priority: "want" as const,
    kind: "variable" as const,
    weeklyLimitVnd: 100_000,
    spentVnd: 150_000,
  };
  const cases = [
    { name: "over by 50,000", row: base, needMode: "penalize", excess: 50_000, deduct: 50_000 },
    {
      name: "exactly at the limit",
      row: { ...base, spentVnd: 100_000 },
      needMode: "penalize",
      excess: 0,
      deduct: 0,
    },
    {
      name: "one VND over",
      row: { ...base, spentVnd: 100_001 },
      needMode: "penalize",
      excess: 1,
      deduct: 1,
    },
    {
      name: "under the limit",
      row: { ...base, spentVnd: 10 },
      needMode: "penalize",
      excess: 0,
      deduct: 0,
    },
    {
      name: "should is treated like want",
      row: { ...base, priority: "should" as const },
      needMode: "penalize",
      excess: 50_000,
      deduct: 50_000,
    },
    {
      name: "need penalized by default",
      row: { ...base, priority: "need" as const },
      needMode: "penalize",
      excess: 50_000,
      deduct: 50_000,
    },
    {
      name: "need warn_only gets no deduction",
      row: { ...base, priority: "need" as const },
      needMode: "warn_only",
      excess: 50_000,
      deduct: 0,
    },
    {
      name: "fund categories have no weekly overspend",
      row: { ...base, priority: "fund" as const },
      needMode: "penalize",
      excess: 0,
      deduct: 0,
    },
    {
      name: "fixed categories have no weekly limit",
      row: { ...base, kind: "fixed" as const },
      needMode: "penalize",
      excess: 0,
      deduct: 0,
    },
  ];
  it.each(cases)("$name", ({ row, needMode, excess, deduct }) => {
    const out = detectOverspends([row], needMode as "penalize" | "warn_only");
    if (excess === 0) {
      expect(out).toEqual([]);
    } else {
      expect(out).toEqual([{ ...row, excessVnd: excess, deductionVnd: deduct }]);
    }
  });
});

describe("effectiveWeeklyLimit", () => {
  it("applies deductions of the week and never goes below zero", () => {
    const adj = [
      { categoryId: "c1", weekIndex: 2, deductionVnd: 30_000 },
      { categoryId: "c1", weekIndex: 2, deductionVnd: 90_000 },
      { categoryId: "c2", weekIndex: 2, deductionVnd: 5 },
    ];
    expect(effectiveWeeklyLimit(100_000, "c1", 2, adj)).toBe(0);
    expect(effectiveWeeklyLimit(100_000, "c2", 2, adj)).toBe(99_995);
    expect(effectiveWeeklyLimit(100_000, "c1", 1, adj)).toBe(100_000);
  });
});

async function seeded(settings: Record<string, unknown> = {}) {
  const store = new MemorySampleBudgetStore();
  let n = 0;
  const newId = () => `id-${++n}`;
  await createOnboardingHandler({
    store,
    locale: "en",
    now: () => NOW,
    newId,
    publish: () => undefined,
  })({
    id: "e0",
    type: "onboarding.step_completed",
    occurredAt: NOW.toISOString(),
    userId: "u1",
    schemaVersion: 1,
    payload: { step: "qa_templates", skipped: true },
  } as EventEnvelope);
  const record = store.get("u1")!;
  record.cycle.state = "running";
  record.cycle.firstDay = FIRST_DAY;
  record.cycle.weeks = 4;
  const category = record.categories.find((c) => c.shortCode === "GT")!;
  category.cycleLimitVnd = 400_000; // weekly 100,000 at the default rounding
  const published: EventEnvelope[] = [];
  const fail = { publish: false };
  const publish = (e: EventEnvelope) => {
    if (fail.publish) throw new Error("bus down");
    published.push(e);
  };
  const spend = createTransactionHandler({
    store,
    now: () => NOW,
    newId,
    publish: () => undefined,
  });
  let r = 0;
  const book = async (amount: number, at = NOW) => {
    r += 1;
    await spend({
      id: `ev-${r}`,
      type: "receipt.parsed",
      occurredAt: at.toISOString(),
      userId: "u1",
      schemaVersion: 1,
      payload: {
        receiptId: `r-${r}`,
        bankTransactionRef: `ref-${r}`,
        bankAccountHint: "MAIN",
        direction: "out",
        amountVnd: amount,
        currency: "VND",
        counterparty: null,
        memo: "GT",
        occurredAt: at.toISOString(),
        source: "email",
        fxProvisional: false,
      },
    } as unknown as EventEnvelope);
  };
  const handle = createWeekClosedHandler({
    store,
    now: () => CLOSE,
    publish,
    readSettings: async () => settings,
  });
  const weekClosed = (weekIndexInCycle: number | null = 1, firstDay = FIRST_DAY) =>
    ({
      id: "wc-1",
      type: "week.closed",
      occurredAt: CLOSE.toISOString(),
      userId: "u1",
      schemaVersion: 1,
      payload: { weekId: `w-${firstDay}`, firstDay, weekIndexInCycle },
    }) as unknown as EventEnvelope;
  return { store, record, category, published, fail, book, handle, weekClosed };
}

const overspends = (p: EventEnvelope[]) =>
  p.filter((e) => e.type === "overspend.detected") as EventEnvelope<"overspend.detected">[];

describe("criterion 1: want category over the weekly limit by 50,000", () => {
  it("emits overspend.detected with excess 50,000 and cuts next week's limit by 50,000", async () => {
    const s = await seeded();
    await s.book(150_000);
    await s.handle(s.weekClosed(1));

    const events = overspends(s.published);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toEqual({
      cycleId: s.record.cycle.id,
      weekIndex: 1,
      categoryId: s.category.id,
      priority: "want",
      weeklyLimitVnd: 100_000,
      spentVnd: 150_000,
      excessVnd: 50_000,
    });
    expect(s.store.get("u1")!.limitAdjustments).toEqual([
      { categoryId: s.category.id, weekIndex: 2, deductionVnd: 50_000 },
    ]);
    expect(s.store.get("u1")!.audit.some((a) => a.action === "week_closed")).toBe(true);
  });

  it("counts only spending inside the closed week", async () => {
    const s = await seeded();
    await s.book(80_000, new Date("2026-03-03T10:00:00Z"));
    await s.book(500_000, new Date("2026-03-09T00:00:00Z")); // next week
    await s.book(500_000, new Date("2026-03-01T23:59:59Z")); // previous week
    await s.handle(s.weekClosed(1));
    expect(overspends(s.published)).toHaveLength(0);
  });

  it("subtracts an earlier deduction from the week's limit", async () => {
    const s = await seeded();
    await s.book(150_000);
    await s.handle(s.weekClosed(1));
    await s.book(80_000, new Date("2026-03-10T10:00:00Z"));
    await s.handle(s.weekClosed(2, "2026-03-09"));
    const second = overspends(s.published)[1]!;
    expect(second.payload).toMatchObject({
      weekIndex: 2,
      weeklyLimitVnd: 50_000,
      excessVnd: 30_000,
    });
  });

  it("derives the week index from the first day when schedule sends none", async () => {
    const s = await seeded();
    await s.book(150_000);
    await s.handle(s.weekClosed(null));
    expect(overspends(s.published)[0]!.payload.weekIndex).toBe(1);
  });

  it("need with warn_only emits the fact but deducts nothing", async () => {
    const s = await seeded({ "penalty.need_overspend_mode": "warn_only" });
    s.category.priority = "need";
    await s.book(150_000);
    await s.handle(s.weekClosed(1));
    expect(overspends(s.published)).toHaveLength(1);
    expect(s.store.get("u1")!.limitAdjustments).toEqual([]);
  });

  it("the last week of the cycle records penalty debt instead of a next-week deduction", async () => {
    const s = await seeded();
    await s.book(150_000, new Date("2026-03-25T10:00:00Z"));
    await s.handle(s.weekClosed(4, "2026-03-23"));
    expect(s.store.get("u1")!.limitAdjustments).toEqual([]);
    expect(s.store.get("u1")!.penaltyDebts).toEqual([
      { cycleId: s.record.cycle.id, categoryId: s.category.id, amountVnd: 50_000 },
    ]);
  });

  it("ignores a week outside the cycle and a cycle that is not running", async () => {
    const s = await seeded();
    await s.book(150_000);
    await s.handle(s.weekClosed(5));
    s.record.cycle.state = "draft";
    await s.handle(s.weekClosed(1));
    expect(s.published).toHaveLength(0);
  });
});

describe("criterion 2: week.closed consumed twice", () => {
  it("runs detection once", async () => {
    const s = await seeded();
    await s.book(150_000);
    await s.handle(s.weekClosed(1));
    await s.handle(s.weekClosed(1));
    expect(overspends(s.published)).toHaveLength(1);
    expect(s.store.get("u1")!.limitAdjustments).toHaveLength(1);
  });

  it("runs once when two deliveries overlap", async () => {
    const s = await seeded();
    await s.book(150_000);
    await Promise.all([s.handle(s.weekClosed(1)), s.handle(s.weekClosed(1))]);
    expect(overspends(s.published)).toHaveLength(1);
    expect(s.store.get("u1")!.limitAdjustments).toHaveLength(1);
  });

  it("a failed publish is retried by the next delivery without a second deduction", async () => {
    const s = await seeded();
    await s.book(150_000);
    s.fail.publish = true;
    await expect(s.handle(s.weekClosed(1))).rejects.toThrow();
    s.fail.publish = false;
    await s.handle(s.weekClosed(1));
    await s.handle(s.weekClosed(1));
    expect(overspends(s.published)).toHaveLength(1);
    expect(s.store.get("u1")!.limitAdjustments).toHaveLength(1);
  });

  it("uses a deterministic event id", async () => {
    const s = await seeded();
    await s.book(150_000);
    await s.handle(s.weekClosed(1));
    expect(overspends(s.published)[0]!.id).toBe(
      `overspend-${s.record.cycle.id}-1-${s.category.id}`,
    );
  });
});
