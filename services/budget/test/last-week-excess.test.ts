import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "@my-wife/contracts";
import { createOnboardingHandler, MemorySampleBudgetStore } from "../src/onboarding";
import { createCycleCloser } from "../src/surplus";
import { effectiveWeeklyLimit, settleLastWeekExcess } from "../src/overspend";

const NOW = new Date("2026-03-05T10:00:00Z");
const CLOSE = new Date("2026-03-30T00:00:01Z");

describe("settleLastWeekExcess (pure)", () => {
  const debts = [
    { cycleId: "c1", categoryId: "a1", amountVnd: 50_000 },
    { cycleId: "c1", categoryId: "b1", amountVnd: 70_001 },
  ];
  const cases = [
    {
      name: "no next cycle: everything stays penalty debt",
      next: undefined,
      deducted: [],
      remaining: [50_000, 70_001],
    },
    {
      name: "next cycle has both categories: both deducted from its first week",
      next: [
        { shortCode: "AN", categoryId: "a2" },
        { shortCode: "DL", categoryId: "b2" },
      ],
      deducted: [
        { categoryId: "a2", weekIndex: 1, deductionVnd: 50_000 },
        { categoryId: "b2", weekIndex: 1, deductionVnd: 70_001 },
      ],
      remaining: [],
    },
    {
      name: "next cycle lacks one category: only that one becomes debt",
      next: [{ shortCode: "AN", categoryId: "a2" }],
      deducted: [{ categoryId: "a2", weekIndex: 1, deductionVnd: 50_000 }],
      remaining: [70_001],
    },
    { name: "no debts", next: [], deducted: [], remaining: [], none: true },
  ];
  it.each(cases)("$name", (c) => {
    const out = settleLastWeekExcess(
      c.none ? [] : debts,
      [
        { categoryId: "a1", shortCode: "AN" },
        { categoryId: "b1", shortCode: "DL" },
      ],
      c.next,
    );
    expect(out.adjustments).toEqual(c.deducted);
    expect(out.remainingDebts.map((d) => d.amountVnd)).toEqual(c.remaining);
    const total = c.none ? 0 : 120_001;
    expect(
      out.adjustments.reduce((s, a) => s + a.deductionVnd, 0) +
        out.remainingDebts.reduce((s, d) => s + d.amountVnd, 0),
    ).toBe(total);
  });
});

async function setup(
  next: { shortCode: string; categoryId: string }[] | undefined,
  debtVnd: number,
) {
  const store = new MemorySampleBudgetStore();
  let n = 0;
  await createOnboardingHandler({
    store,
    locale: "en",
    now: () => NOW,
    newId: () => `id-${++n}`,
    publish: () => undefined,
  } as never)({
    id: "e0",
    type: "onboarding.step_completed",
    occurredAt: NOW.toISOString(),
    userId: "u1",
    schemaVersion: 1,
    payload: { step: "qa_templates", skipped: true },
  } as EventEnvelope);
  const record = store.get("u1")!;
  record.cycle.state = "closing";
  const food = record.categories.find((c) => c.shortCode === "AN")!;
  if (debtVnd > 0) {
    record.penaltyDebts.push({ cycleId: record.cycle.id, categoryId: food.id, amountVnd: debtVnd });
  }
  const published: EventEnvelope[] = [];
  const close = createCycleCloser({
    store,
    now: () => CLOSE,
    publish: (e) => void published.push(e),
    readSettings: async () => ({}),
    findNextCycleCategories: async () => next,
  });
  return { store, record, food, close, published };
}

describe("closing a cycle with last-week excess", () => {
  it("deducts it from the first week of the next cycle and audits it", async () => {
    const s = await setup([{ shortCode: "AN", categoryId: "next-an" }], 50_000);
    expect((await s.close("u1")).ok).toBe(true);
    expect(s.record.limitAdjustments).toEqual([
      { categoryId: "next-an", weekIndex: 1, deductionVnd: 50_000 },
    ]);
    expect(effectiveWeeklyLimit(300_000, "next-an", 1, s.record.limitAdjustments)).toBe(250_000);
    expect(s.record.penaltyDebts).toEqual([]);
    const audit = s.record.audit.find((a) => a.action === "last_week_excess_settled");
    expect(audit?.detail).toMatchObject({ deductedVnd: 50_000, debtVnd: 0 });
  });

  it("keeps it as penalty debt when the next cycle has no such category", async () => {
    const s = await setup(undefined, 50_000);
    await s.close("u1");
    expect(s.record.limitAdjustments).toEqual([]);
    expect(s.record.penaltyDebts).toEqual([
      { cycleId: s.record.cycle.id, categoryId: s.food.id, amountVnd: 50_000 },
    ]);
    const audit = s.record.audit.find((a) => a.action === "last_week_excess_settled");
    expect(audit?.detail).toMatchObject({ deductedVnd: 0, debtVnd: 50_000 });
  });

  it("settles once: a repeated close does not deduct twice", async () => {
    const s = await setup([{ shortCode: "AN", categoryId: "next-an" }], 50_000);
    await s.close("u1");
    await s.close("u1");
    expect(s.record.limitAdjustments).toHaveLength(1);
  });

  it("writes no settlement audit when there is no excess", async () => {
    const s = await setup([{ shortCode: "AN", categoryId: "next-an" }], 0);
    await s.close("u1");
    expect(s.record.audit.some((a) => a.action === "last_week_excess_settled")).toBe(false);
  });
});
