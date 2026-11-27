import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "@my-wife/contracts";
import { createOnboardingHandler, MemorySampleBudgetStore } from "../src/onboarding";
import { createCycleCloser, splitSurplus, surplusTotalVnd } from "../src/surplus";

const NOW = new Date("2026-03-05T10:00:00Z");
const CLOSE = new Date("2026-03-30T00:00:01Z");

describe("splitSurplus (pure)", () => {
  const cases = [
    { name: "defaults 30/20", total: 1_000_000, s: 30, f: 20, out: [300_000, 200_000, 500_000] },
    {
      name: "rounds shares down, remainder takes the rest",
      total: 1_001,
      s: 30,
      f: 20,
      out: [300, 200, 501],
    },
    { name: "one VND", total: 1, s: 30, f: 20, out: [0, 0, 1] },
    { name: "zero surplus", total: 0, s: 30, f: 20, out: [0, 0, 0] },
    { name: "all to savings", total: 777, s: 100, f: 0, out: [777, 0, 0] },
    { name: "zero shares", total: 999, s: 0, f: 0, out: [0, 0, 999] },
    { name: "odd total 33/33", total: 100_001, s: 33, f: 33, out: [33_000, 33_000, 34_001] },
    {
      name: "large total stays exact",
      total: 9_007_199_254_740,
      s: 30,
      f: 20,
      out: [2_702_159_776_422, 1_801_439_850_948, 4_503_599_627_370],
    },
  ];
  it.each(cases)("$name", (c) => {
    const r = splitSurplus(c.total, c.s, c.f);
    expect([r.savingsVnd, r.futurePurchasesVnd, r.remainderVnd]).toEqual(c.out);
    expect(r.savingsVnd + r.futurePurchasesVnd + r.remainderVnd).toBe(c.total);
  });
});

async function setup(settings: Record<string, unknown> = {}) {
  const store = new MemorySampleBudgetStore();
  let n = 0;
  const newId = () => `id-${++n}`;
  const onboard = createOnboardingHandler({
    store,
    locale: "en",
    now: () => NOW,
    newId,
    publish: () => undefined,
  } as never);
  await onboard({
    id: "e0",
    type: "onboarding.step_completed",
    occurredAt: NOW.toISOString(),
    userId: "u1",
    schemaVersion: 1,
    payload: { step: "qa_templates", skipped: true },
  } as EventEnvelope);
  const record = store.get("u1")!;
  record.cycle.state = "closing";
  record.cycle.firstDay = "2026-03-02";
  record.cycle.weeks = 4;
  for (const c of record.categories) c.cycleLimitVnd = 0;
  const cat = (code: string, limit: number) => {
    const c = record.categories.find((x) => x.shortCode === code)!;
    c.cycleLimitVnd = limit;
    return c;
  };
  const published: EventEnvelope[] = [];
  const fail = { publish: false };
  const close = createCycleCloser({
    store,
    now: () => CLOSE,
    publish: (e) => {
      if (fail.publish) throw new Error("bus down");
      published.push(e);
    },
    readSettings: async () => settings,
  });
  let r = 0;
  const book = (amount: number, shortCode: string) => {
    r += 1;
    const category = record.categories.find((x) => x.shortCode === shortCode)!;
    record.transactions.push({
      id: `t-${r}`,
      cycleId: record.cycle.id,
      receiptId: `r-${r}`,
      bankTransactionRef: `ref-${r}`,
      bankAccountId: category.bankAccountId,
      direction: "out",
      amountVnd: amount,
      occurredAt: NOW.toISOString(),
      memo: shortCode,
      counterparty: null,
      transactionType: "coded_unplanned",
      reconciliationResult: "unplanned",
      categoryId: category.id,
      announced: true,
    });
  };
  return { store, record, cat, published, fail, close, book };
}

const ofType = (p: EventEnvelope[], type: string) => p.filter((e) => e.type === type);

describe("surplusTotalVnd (pure)", () => {
  it("sums positive remainders of counting categories only", async () => {
    const s = await setup();
    s.cat("AN", 1_000_000);
    s.cat("DL", 500_000);
    const fixed = s.cat("HD", 800_000);
    expect(fixed.countsTowardSurplus).toBe(false);
    s.book(300_000, "AN");
    s.book(700_000, "DL"); // overspent: contributes 0, never negative
    expect(surplusTotalVnd(s.store.get("u1")!)).toBe(700_000);
  });
});

describe("closing a cycle", () => {
  it("allocates by the default ratios and closes the cycle", async () => {
    const s = await setup();
    s.cat("AN", 1_000_000);
    s.cat("DL", 500_000);
    s.book(250_001, "AN");
    const res = await s.close("u1");
    // remaining: 749_999 + 500_000 = 1_249_999
    expect(res).toEqual({
      ok: true,
      data: {
        cycleId: s.record.cycle.id,
        totalVnd: 1_249_999,
        savingsVnd: 374_999,
        futurePurchasesVnd: 249_999,
        remainderVnd: 625_001,
        remainderTarget: "savings",
      },
    });
    expect(s.record.cycle.state).toBe("closed");
    expect(s.record.cycle.closedAt).toBe(CLOSE.toISOString());
    expect(ofType(s.published, "surplus.allocated")).toHaveLength(1);
    const closed = ofType(s.published, "cycle.closed");
    expect(closed).toHaveLength(1);
    expect((closed[0]!.payload as { surplus: { totalVnd: number } }).surplus.totalVnd).toBe(
      1_249_999,
    );
    expect(s.record.audit.some((a) => a.action === "cycle_closed")).toBe(true);
  });

  it("follows user-configured ratios and remainder target", async () => {
    const s = await setup({
      "budget.surplus_share_savings_percent": 50,
      "budget.surplus_share_future_purchases_percent": 10,
      "budget.surplus_remainder_target": "future_purchases",
    });
    s.cat("AN", 1_000_000);
    const res = await s.close("u1");
    expect(res).toMatchObject({
      ok: true,
      data: {
        savingsVnd: 500_000,
        futurePurchasesVnd: 100_000,
        remainderVnd: 400_000,
        remainderTarget: "future_purchases",
      },
    });
  });

  it("falls back to defaults when ratios exceed 100 together", async () => {
    const s = await setup({
      "budget.surplus_share_savings_percent": 80,
      "budget.surplus_share_future_purchases_percent": 40,
    });
    s.cat("AN", 1_000_000);
    expect(await s.close("u1")).toMatchObject({
      ok: true,
      data: { savingsVnd: 300_000, futurePurchasesVnd: 200_000, remainderVnd: 500_000 },
    });
  });

  it("closes with a zero surplus", async () => {
    const s = await setup();
    const res = await s.close("u1");
    expect(res).toMatchObject({ ok: true, data: { totalVnd: 0, remainderVnd: 0 } });
    expect(s.record.cycle.state).toBe("closed");
  });

  it("refuses a cycle that is not closing", async () => {
    const s = await setup();
    s.record.cycle.state = "running";
    expect(await s.close("u1")).toEqual({ ok: false, error: { code: "budget.cycle_not_closing" } });
    expect(s.published).toHaveLength(0);
  });

  it("refuses an unknown user", async () => {
    const s = await setup();
    expect(await s.close("nobody")).toEqual({
      ok: false,
      error: { code: "budget.cycle_not_found" },
    });
  });

  it("is idempotent: a second close changes and publishes nothing more", async () => {
    const s = await setup();
    s.cat("AN", 1_000_000);
    const first = await s.close("u1");
    const second = await s.close("u1");
    expect(second).toEqual(first);
    expect(s.published).toHaveLength(2);
    expect(s.record.audit.filter((a) => a.action === "cycle_closed")).toHaveLength(1);
  });

  it("retries a failed publish without allocating twice", async () => {
    const s = await setup();
    s.cat("AN", 1_000_000);
    s.fail.publish = true;
    await expect(s.close("u1")).rejects.toThrow("bus down");
    expect(s.record.cycle.state).toBe("closed");
    s.fail.publish = false;
    await s.close("u1");
    expect(ofType(s.published, "surplus.allocated")).toHaveLength(1);
    expect(ofType(s.published, "cycle.closed")).toHaveLength(1);
    expect(s.record.audit.filter((a) => a.action === "cycle_closed")).toHaveLength(1);
  });
});
