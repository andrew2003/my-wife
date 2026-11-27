import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "@my-wife/contracts";
import { createOnboardingHandler, MemorySampleBudgetStore } from "../src/onboarding";
import { createTransactionHandler } from "../src/transactions";
import { createWeekClosedHandler, type OverspendFinding } from "../src/overspend";
import { applyExceptions, contingencyBalanceVnd, createExceptionClaimer } from "../src/exceptions";

const NOW = new Date("2026-03-05T10:00:00Z");
const CLOSE = new Date("2026-03-09T00:00:01Z");
const FIRST_DAY = "2026-03-02";

const finding = (categoryId: string, excessVnd: number): OverspendFinding => ({
  categoryId,
  priority: "want",
  kind: "variable",
  weeklyLimitVnd: 100_000,
  spentVnd: 100_000 + excessVnd,
  excessVnd,
  deductionVnd: excessVnd,
});

describe("contingencyBalanceVnd (pure)", () => {
  const cases = [
    { name: "untouched", limit: 500_000, spent: 0, funded: 0, balance: 500_000 },
    { name: "partly spent", limit: 500_000, spent: 120_000, funded: 30_000, balance: 350_000 },
    { name: "exactly used", limit: 500_000, spent: 300_000, funded: 200_000, balance: 0 },
    { name: "never below zero", limit: 500_000, spent: 600_000, funded: 0, balance: 0 },
  ];
  it.each(cases)("$name", (c) => {
    expect(
      contingencyBalanceVnd({ limitVnd: c.limit, spentVnd: c.spent, fundedVnd: c.funded }),
    ).toBe(c.balance);
  });
});

describe("applyExceptions (pure)", () => {
  const cases = [
    {
      name: "fully funded",
      findings: [finding("a", 50_000)],
      claimed: ["a"],
      balance: 500_000,
      remaining: [],
      funded: [{ categoryId: "a", fundedVnd: 50_000 }],
    },
    {
      name: "not claimed stays an overspend",
      findings: [finding("a", 50_000)],
      claimed: [],
      balance: 500_000,
      remaining: [["a", 50_000]],
      funded: [],
    },
    {
      name: "balance covers only part",
      findings: [finding("a", 50_000)],
      claimed: ["a"],
      balance: 20_000,
      remaining: [["a", 30_000]],
      funded: [{ categoryId: "a", fundedVnd: 20_000 }],
    },
    {
      name: "empty fund funds nothing",
      findings: [finding("a", 50_000)],
      claimed: ["a"],
      balance: 0,
      remaining: [["a", 50_000]],
      funded: [{ categoryId: "a", fundedVnd: 0 }],
    },
    {
      name: "two claims share one balance",
      findings: [finding("a", 40_000), finding("b", 40_000)],
      claimed: ["a", "b"],
      balance: 60_000,
      remaining: [["b", 20_000]],
      funded: [
        { categoryId: "a", fundedVnd: 40_000 },
        { categoryId: "b", fundedVnd: 20_000 },
      ],
    },
  ];
  it.each(cases)("$name", (c) => {
    const out = applyExceptions(c.findings, new Set(c.claimed), c.balance);
    expect(out.findings.map((f) => [f.categoryId, f.excessVnd])).toEqual(c.remaining);
    expect(out.funded).toEqual(c.funded);
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
  category.cycleLimitVnd = 400_000; // weekly 100,000
  const fund = record.categories.find((c) => c.shortCode === "DP")!;
  fund.cycleLimitVnd = 500_000;
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
  const book = async (amount: number, memo = "GT") => {
    r += 1;
    await spend({
      id: `ev-${r}`,
      type: "receipt.parsed",
      occurredAt: NOW.toISOString(),
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
        memo,
        occurredAt: NOW.toISOString(),
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
  const claim = createExceptionClaimer({
    store,
    now: () => NOW,
    newId,
    readSettings: async () => settings,
  });
  const weekClosed = (weekIndexInCycle = 1) =>
    ({
      id: "wc-1",
      type: "week.closed",
      occurredAt: CLOSE.toISOString(),
      userId: "u1",
      schemaVersion: 1,
      payload: { weekId: `w-${FIRST_DAY}`, firstDay: FIRST_DAY, weekIndexInCycle },
    }) as unknown as EventEnvelope;
  return { store, record, category, fund, published, fail, book, handle, claim, weekClosed };
}

const ofType = (p: EventEnvelope[], type: string) => p.filter((e) => e.type === type);

describe("criterion: an exception claimed before week close is applied", () => {
  it("emits exception.used and debits the contingency fund, with no overspend", async () => {
    const s = await seeded();
    await s.book(150_000);
    const claimed = await s.claim("u1", { categoryId: s.category.id });
    expect(claimed.ok).toBe(true);

    await s.handle(s.weekClosed());

    const used = ofType(s.published, "exception.used") as EventEnvelope<"exception.used">[];
    expect(used).toHaveLength(1);
    expect(used[0]!.payload).toEqual({
      cycleId: s.record.cycle.id,
      weekIndex: 1,
      categoryId: s.category.id,
      excessVnd: 50_000,
    });
    expect(ofType(s.published, "overspend.detected")).toHaveLength(0);
    const after = s.store.get("u1")!;
    expect(after.exceptionClaims[0]).toMatchObject({ state: "applied", fundedVnd: 50_000 });
    expect(after.limitAdjustments).toEqual([]);
    expect(after.audit.some((a) => a.action === "exception_used")).toBe(true);
  });

  it("debits the fund so a later exception sees the lower balance", async () => {
    const s = await seeded();
    await s.book(150_000);
    await s.claim("u1", { categoryId: s.category.id });
    await s.handle(s.weekClosed());
    const { contingencyBalanceOf } = await import("../src/exceptions");
    expect(contingencyBalanceOf(s.store.get("u1")!)).toBe(450_000);
  });

  it("is applied once when the week.closed event is delivered twice", async () => {
    const s = await seeded();
    await s.book(150_000);
    await s.claim("u1", { categoryId: s.category.id });
    await s.handle(s.weekClosed());
    await s.handle(s.weekClosed());
    expect(ofType(s.published, "exception.used")).toHaveLength(1);
    expect(s.store.get("u1")!.exceptionClaims[0]!.fundedVnd).toBe(50_000);
  });

  it("retries a failed publish without debiting twice", async () => {
    const s = await seeded();
    await s.book(150_000);
    await s.claim("u1", { categoryId: s.category.id });
    s.fail.publish = true;
    await expect(s.handle(s.weekClosed())).rejects.toThrow("bus down");
    s.fail.publish = false;
    await s.handle(s.weekClosed());
    expect(ofType(s.published, "exception.used")).toHaveLength(1);
    expect(s.store.get("u1")!.exceptionClaims[0]!.fundedVnd).toBe(50_000);
  });

  it("never takes the fund below zero; the rest stays a penalized overspend", async () => {
    const s = await seeded();
    s.fund.cycleLimitVnd = 20_000;
    await s.book(150_000);
    await s.claim("u1", { categoryId: s.category.id });
    await s.handle(s.weekClosed());
    const used = ofType(s.published, "exception.used") as EventEnvelope<"exception.used">[];
    expect(used[0]!.payload.excessVnd).toBe(20_000);
    const over = ofType(s.published, "overspend.detected") as EventEnvelope<"overspend.detected">[];
    expect(over[0]!.payload.excessVnd).toBe(30_000);
    expect(s.store.get("u1")!.limitAdjustments).toEqual([
      { categoryId: s.category.id, weekIndex: 2, deductionVnd: 30_000 },
    ]);
  });

  it("does not fund an overspend that was not claimed", async () => {
    const s = await seeded();
    await s.book(150_000);
    await s.handle(s.weekClosed());
    expect(ofType(s.published, "exception.used")).toHaveLength(0);
    expect(ofType(s.published, "overspend.detected")).toHaveLength(1);
  });

  it("releases a claim with no excess so it does not use up the quota", async () => {
    const s = await seeded({ "budget.exceptions_per_cycle": 1 });
    await s.book(50_000);
    await s.claim("u1", { categoryId: s.category.id });
    await s.handle(s.weekClosed());
    expect(ofType(s.published, "exception.used")).toHaveLength(0);
    expect(s.store.get("u1")!.exceptionClaims[0]!.state).toBe("released");
    const again = await s.claim("u1", { categoryId: s.category.id, weekIndex: 2 });
    expect(again.ok).toBe(true);
  });
});

describe("claiming an exception", () => {
  it("refuses beyond budget.exceptions_per_cycle (default 2)", async () => {
    const s = await seeded();
    expect((await s.claim("u1", { categoryId: s.category.id, weekIndex: 1 })).ok).toBe(true);
    expect((await s.claim("u1", { categoryId: s.category.id, weekIndex: 2 })).ok).toBe(true);
    const third = await s.claim("u1", { categoryId: s.category.id, weekIndex: 3 });
    expect(third).toEqual({ ok: false, error: { code: "budget.exception_limit_reached" } });
  });

  it("honors a user setting of 0 and a larger quota", async () => {
    const zero = await seeded({ "budget.exceptions_per_cycle": 0 });
    expect((await zero.claim("u1", { categoryId: zero.category.id })).ok).toBe(false);
    const four = await seeded({ "budget.exceptions_per_cycle": 4 });
    for (const week of [1, 2, 3, 4]) {
      expect((await four.claim("u1", { categoryId: four.category.id, weekIndex: week })).ok).toBe(
        true,
      );
    }
  });

  it("refuses a second claim for the same category and week", async () => {
    const s = await seeded();
    await s.claim("u1", { categoryId: s.category.id });
    expect(await s.claim("u1", { categoryId: s.category.id })).toEqual({
      ok: false,
      error: { code: "budget.exception_already_claimed" },
    });
  });

  it("refuses after the week closed", async () => {
    const s = await seeded();
    await s.handle(s.weekClosed());
    expect(await s.claim("u1", { categoryId: s.category.id, weekIndex: 1 })).toEqual({
      ok: false,
      error: { code: "budget.week_not_open" },
    });
  });

  it("refuses fund categories and unknown categories", async () => {
    const s = await seeded();
    expect(await s.claim("u1", { categoryId: s.fund.id })).toEqual({
      ok: false,
      error: { code: "budget.exception_not_allowed" },
    });
    expect(await s.claim("u1", { categoryId: "nope" })).toEqual({
      ok: false,
      error: { code: "budget.category_not_found" },
    });
  });

  it("defaults to the current week from the injected clock", async () => {
    const s = await seeded();
    const res = await s.claim("u1", { categoryId: s.category.id });
    expect(res.ok).toBe(true);
    expect(s.store.get("u1")!.exceptionClaims[0]!.weekIndex).toBe(1);
  });
});
