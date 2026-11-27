import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "@my-wife/contracts";
import { createOnboardingHandler, MemorySampleBudgetStore } from "../src/onboarding";
import {
  createGroupExpenseRecorder,
  createIncomeRecorder,
  incomePoolTotalVnd,
  splitGroupExpense,
} from "../src/income-pool";

const NOW = new Date("2026-03-05T10:00:00Z");
const DAY = 86_400_000;

describe("splitGroupExpense (pure)", () => {
  const cases = [
    {
      name: "explicit shares: the user keeps the rest",
      total: 1_000_000,
      friends: [
        { person: "An", shareVnd: 300_000 },
        { person: "Binh", shareVnd: 250_000 },
      ],
      own: undefined,
      expected: { ownShareVnd: 450_000, shares: [300_000, 250_000] },
    },
    {
      name: "no shares: equal split by head count, the user takes the remainder",
      total: 1_000_000,
      friends: [{ person: "An" }, { person: "Binh" }, { person: "Chi" }],
      own: undefined,
      expected: { ownShareVnd: 250_000, shares: [250_000, 250_000, 250_000] },
    },
    {
      name: "no shares: remainder VND stays with the user",
      total: 1_000_001,
      friends: [{ person: "An" }, { person: "Binh" }],
      own: undefined,
      expected: { ownShareVnd: 333_335, shares: [333_333, 333_333] },
    },
    {
      name: "own share given: the rest is split among friends",
      total: 1_000_000,
      friends: [{ person: "An" }, { person: "Binh" }, { person: "Chi" }],
      own: 100_000,
      expected: { ownShareVnd: 100_000, shares: [300_000, 300_000, 300_000] },
    },
    {
      name: "own share given: leftover VND goes one each to the first friends",
      total: 1_000_001,
      friends: [{ person: "An" }, { person: "Binh" }],
      own: 500_000,
      expected: { ownShareVnd: 500_000, shares: [250_001, 250_000] },
    },
    {
      name: "explicit shares and a matching own share",
      total: 100_000,
      friends: [{ person: "An", shareVnd: 40_000 }],
      own: 60_000,
      expected: { ownShareVnd: 60_000, shares: [40_000] },
    },
    {
      name: "shares above the total are invalid",
      total: 100_000,
      friends: [{ person: "An", shareVnd: 150_000 }],
      own: undefined,
      expected: null,
    },
    {
      name: "mixed explicit and missing shares are invalid",
      total: 100_000,
      friends: [{ person: "An", shareVnd: 10_000 }, { person: "Binh" }],
      own: undefined,
      expected: null,
    },
    {
      name: "explicit shares with an own share that does not add up are invalid",
      total: 100_000,
      friends: [{ person: "An", shareVnd: 40_000 }],
      own: 50_000,
      expected: null,
    },
    { name: "no friends is invalid", total: 100_000, friends: [], own: undefined, expected: null },
    {
      name: "own share above the total is invalid",
      total: 100_000,
      friends: [{ person: "An" }],
      own: 200_000,
      expected: null,
    },
    {
      name: "a zero share is invalid",
      total: 100,
      friends: [{ person: "An", shareVnd: 0 }],
      own: undefined,
      expected: null,
    },
  ];
  it.each(cases)("$name", ({ total, friends, own, expected }) => {
    const result = splitGroupExpense(total, friends, own);
    if (expected === null) {
      expect(result).toBeNull();
    } else {
      expect(result).toEqual({
        ownShareVnd: expected.ownShareVnd,
        shares: expected.shares.map((shareVnd, i) => ({ person: friends[i]!.person, shareVnd })),
      });
      expect(result!.ownShareVnd + result!.shares.reduce((s, x) => s + x.shareVnd, 0)).toBe(total);
    }
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
  store.get("u1")!.cycle.state = "running";
  const published: EventEnvelope[] = [];
  const fail = { publish: false };
  const publish = (e: EventEnvelope) => {
    if (fail.publish) throw new Error("bus down");
    published.push(e);
  };
  const deps = { store, now: () => NOW, newId, publish, readSettings: async () => settings };
  return {
    store,
    published,
    fail,
    group: createGroupExpenseRecorder(deps),
    income: createIncomeRecorder(deps),
    categoryId: store.get("u1")!.categories[0]!.id,
  };
}

describe("group expense", () => {
  it("opens a receivable per friend for a dinner the user paid", async () => {
    const t = await seeded();
    const result = await t.group.record("u1", {
      totalVnd: 900_000,
      categoryId: t.categoryId,
      friends: [
        { person: "An", shareVnd: 200_000 },
        { person: "Binh", shareVnd: 300_000 },
      ],
    });
    expect(result.ok).toBe(true);
    const debts = t.store.get("u1")!.debts;
    expect(
      debts.map((d) => [d.kind, d.person, d.amountVnd, d.state, d.fundingCategoryId]),
    ).toEqual([
      ["receivable", "An", 200_000, "open", t.categoryId],
      ["receivable", "Binh", 300_000, "open", t.categoryId],
    ]);
    expect(result.ok && result.data.ownShareVnd).toBe(400_000);
    expect(t.published.filter((e) => e.type === "debt.opened")).toHaveLength(2);
    expect(t.store.get("u1")!.audit.filter((a) => a.action === "debt_opened")).toHaveLength(2);
  });

  it("the due date is the opening time plus the collect days setting", async () => {
    const t = await seeded({ "debt.group_expense_collect_days": 3 });
    await t.group.record("u1", {
      totalVnd: 100_000,
      categoryId: t.categoryId,
      friends: [{ person: "An" }],
    });
    expect(t.store.get("u1")!.debts[0]!.dueAt).toBe(
      new Date(NOW.getTime() + 3 * DAY).toISOString(),
    );
  });

  it("a requested due date is kept", async () => {
    const t = await seeded();
    await t.group.record("u1", {
      totalVnd: 100_000,
      categoryId: t.categoryId,
      friends: [{ person: "An" }],
      dueAt: "2026-04-01T00:00:00.000Z",
    });
    expect(t.store.get("u1")!.debts[0]!.dueAt).toBe("2026-04-01T00:00:00.000Z");
  });

  it.each([
    {
      name: "unknown category",
      body: { totalVnd: 1000, categoryId: "nope", friends: [{ person: "An" }] },
    },
    { name: "zero total", body: { totalVnd: 0, friends: [{ person: "An" }] } },
    { name: "fractional total", body: { totalVnd: 10.5, friends: [{ person: "An" }] } },
    { name: "no friends", body: { totalVnd: 1000, friends: [] } },
    {
      name: "shares above total",
      body: { totalVnd: 1000, friends: [{ person: "An", shareVnd: 2000 }] },
    },
  ])("rejects $name and opens nothing", async ({ body }) => {
    const t = await seeded();
    const result = await t.group.record("u1", body);
    expect(result).toEqual({ ok: false, error: { code: "budget.invalid_group_expense" } });
    expect(t.store.get("u1")!.debts).toHaveLength(0);
  });

  it("unknown user is not found", async () => {
    const t = await seeded();
    const result = await t.group.record("nobody", { totalVnd: 1000, friends: [{ person: "An" }] });
    expect(result).toEqual({ ok: false, error: { code: "budget.cycle_not_found" } });
  });

  it("a failed publish is retried without duplicating debts", async () => {
    const t = await seeded();
    t.fail.publish = true;
    await t.group
      .record("u1", { totalVnd: 1000, friends: [{ person: "An" }] })
      .catch(() => undefined);
    expect(t.store.get("u1")!.debts).toHaveLength(1);
    t.fail.publish = false;
    await t.group.announceOwed("u1");
    expect(t.published.filter((e) => e.type === "debt.opened")).toHaveLength(1);
  });
});

describe("income pool", () => {
  it("records income, emits income.recorded and the pool grows", async () => {
    const t = await seeded();
    const first = await t.income.record("u1", { amountVnd: 15_000_000, payer: "ACME" });
    const second = await t.income.record("u1", { amountVnd: 2_500_000, payer: "Freelance" });
    expect(first.ok && second.ok).toBe(true);
    expect(incomePoolTotalVnd(t.store.get("u1")!.incomePool)).toBe(17_500_000);
    const events = t.published.filter((e) => e.type === "income.recorded");
    expect(events.map((e) => e.payload)).toEqual([
      { entryId: first.ok ? first.data.entryId : "", amountVnd: 15_000_000, payer: "ACME" },
      { entryId: second.ok ? second.data.entryId : "", amountVnd: 2_500_000, payer: "Freelance" },
    ]);
    expect(t.store.get("u1")!.audit.filter((a) => a.action === "income_recorded")).toHaveLength(2);
    expect(t.store.get("u1")!.incomePool[0]!.receivedAt).toBe(NOW.toISOString());
  });

  it("a failed publish keeps the entry and is retried once", async () => {
    const t = await seeded();
    t.fail.publish = true;
    await t.income.record("u1", { amountVnd: 1000, payer: "ACME" }).catch(() => undefined);
    expect(t.store.get("u1")!.incomePool).toHaveLength(1);
    t.fail.publish = false;
    await t.income.announcePending("u1");
    await t.income.announcePending("u1");
    expect(t.published.filter((e) => e.type === "income.recorded")).toHaveLength(1);
  });

  it.each([
    { name: "zero", body: { amountVnd: 0, payer: "A" } },
    { name: "negative", body: { amountVnd: -5, payer: "A" } },
    { name: "fractional", body: { amountVnd: 1.5, payer: "A" } },
    { name: "empty payer", body: { amountVnd: 100, payer: "" } },
  ])("rejects $name", async ({ body }) => {
    const t = await seeded();
    expect(await t.income.record("u1", body)).toEqual({
      ok: false,
      error: { code: "budget.invalid_income" },
    });
    expect(t.store.get("u1")!.incomePool).toHaveLength(0);
  });

  it("the pool total counts only unallocated entries", () => {
    const e = (amountVnd: number, allocatedCycleId: string | null) => ({
      id: "x",
      amountVnd,
      payer: "p",
      receivedAt: NOW.toISOString(),
      sourceTransactionId: "t",
      allocatedCycleId,
      announced: true,
    });
    expect(incomePoolTotalVnd([e(100, null), e(50, "c1"), e(25, null)])).toBe(125);
    expect(incomePoolTotalVnd([])).toBe(0);
  });
});
