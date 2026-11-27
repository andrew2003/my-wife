import { describe, expect, it } from "vitest";
import type { EventEnvelope, SettingKey } from "@my-wife/contracts";
import { createOnboardingHandler, MemorySampleBudgetStore } from "../src/onboarding";
import { createTransactionHandler, getCategoryBalances } from "../src/transactions";
import { createRefundTransferHandler } from "../src/refund-wiring";

const NOW = new Date("2026-03-05T10:00:00Z");
const LATER = new Date("2026-03-06T10:00:00Z");

interface R {
  ref: string;
  amount: number;
  direction?: "in" | "out";
  hint?: string;
  memo?: string;
  counterparty?: string | null;
  at?: string;
}

function receipt(o: R): EventEnvelope {
  return {
    id: `ev-${o.ref}`,
    type: "receipt.parsed",
    occurredAt: o.at ?? NOW.toISOString(),
    userId: "u1",
    schemaVersion: 1,
    payload: {
      receiptId: `r-${o.ref}`,
      bankTransactionRef: o.ref,
      bankAccountHint: o.hint ?? "MAIN",
      direction: o.direction ?? "in",
      amountVnd: o.amount,
      currency: "VND",
      counterparty: o.counterparty === undefined ? "Shop A" : o.counterparty,
      memo: o.memo ?? "",
      occurredAt: o.at ?? NOW.toISOString(),
      source: "email",
      fxProvisional: false,
    },
  } as unknown as EventEnvelope;
}

/** A leg between two own accounts: no counterparty, so it can never look like a refund. */
const leg = (o: R) => receipt({ counterparty: null, ...o });

async function seeded(settings: Partial<Record<SettingKey, unknown>> = {}) {
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
  const published: EventEnvelope[] = [];
  const fail = { publish: false };
  const publish = (e: EventEnvelope) => {
    if (fail.publish) throw new Error("bus down");
    published.push(e);
  };
  const coded = createTransactionHandler({ store, now: () => LATER, newId, publish });
  const wiring = createRefundTransferHandler({
    store,
    now: () => LATER,
    newId,
    publish,
    readSettings: async () => settings,
  });
  const handle = async (e: EventEnvelope) => {
    await coded(e);
    await wiring(e);
  };
  const category = record.categories.find((c) => c.shortCode === "AN")!;
  return { store, record, handle, published, fail, category };
}
type S = Awaited<ReturnType<typeof seeded>>;

const balanceOf = (s: S) =>
  getCategoryBalances(s.store.get("u1")!).find((b) => b.categoryId === s.category.id)!;
const types = (s: S, type: string) => s.published.filter((e) => e.type === type);

/** Puts an outgoing payment to "Shop A" into the category so a refund has an original. */
function pay(s: S, ref: string, amount: number, at = "2026-03-04T10:00:00Z") {
  const rec = s.store.get("u1")!;
  rec.transactions.push({
    id: `orig-${ref}`,
    cycleId: rec.cycle.id,
    receiptId: `r-${ref}`,
    bankTransactionRef: ref,
    bankAccountId: s.category.bankAccountId,
    direction: "out",
    amountVnd: amount,
    occurredAt: at,
    memo: "an",
    counterparty: "Shop A",
    transactionType: "coded_unplanned",
    reconciliationResult: "unplanned",
    categoryId: s.category.id,
    announced: true,
  });
}

describe("refund wiring (criterion 1)", () => {
  const cases = [
    {
      name: "refund above original",
      original: 200_000,
      refund: 300_000,
      restored: 200_000,
      income: 100_000,
    },
    {
      name: "refund equal to original",
      original: 200_000,
      refund: 200_000,
      restored: 200_000,
      income: 0,
    },
    { name: "partial refund", original: 200_000, refund: 50_000, restored: 50_000, income: 0 },
    { name: "one VND over", original: 200_000, refund: 200_001, restored: 200_000, income: 1 },
  ];
  it.each(cases)("$name", async ({ original, refund, restored, income }) => {
    const s = await seeded();
    pay(s, "o1", original);
    await s.handle(receipt({ ref: "f1", amount: refund }));

    expect(balanceOf(s).spentVnd).toBe(original - restored);
    const rec = s.store.get("u1")!;
    const txn = rec.transactions.find((t) => t.bankTransactionRef === "f1")!;
    expect(txn).toMatchObject({
      transactionType: "refund",
      refundOfTransactionId: "orig-o1",
      restoredVnd: restored,
      categoryId: s.category.id,
    });
    expect(types(s, "txn.recorded")).toHaveLength(1);
    expect(rec.audit.some((a) => a.action === "transaction_recorded")).toBe(true);
    if (income === 0) {
      expect(rec.incomePool).toHaveLength(0);
      expect(types(s, "income.recorded")).toHaveLength(0);
    } else {
      expect(rec.incomePool).toEqual([
        expect.objectContaining({ amountVnd: income, payer: "Shop A", announced: true }),
      ]);
      const ev = types(s, "income.recorded")[0] as EventEnvelope<"income.recorded">;
      expect(ev.payload).toMatchObject({ amountVnd: income, payer: "Shop A" });
      expect(rec.audit.some((a) => a.action === "income_recorded")).toBe(true);
    }
  });

  it("a second refund is capped by what is left of the original", async () => {
    const s = await seeded();
    pay(s, "o1", 200_000);
    await s.handle(receipt({ ref: "f1", amount: 150_000 }));
    await s.handle(receipt({ ref: "f2", amount: 100_000 }));
    expect(balanceOf(s).spentVnd).toBe(0);
    expect(s.store.get("u1")!.incomePool.map((e) => e.amountVnd)).toEqual([50_000]);
  });

  it("links the most recent original of the payer that still has room", async () => {
    const s = await seeded();
    pay(s, "o1", 100_000, "2026-03-02T10:00:00Z");
    pay(s, "o2", 100_000, "2026-03-03T10:00:00Z");
    await s.handle(receipt({ ref: "f1", amount: 100_000 }));
    await s.handle(receipt({ ref: "f2", amount: 100_000 }));
    const t = s.store.get("u1")!.transactions;
    expect(t.find((x) => x.bankTransactionRef === "f1")!.refundOfTransactionId).toBe("orig-o2");
    expect(t.find((x) => x.bankTransactionRef === "f2")!.refundOfTransactionId).toBe("orig-o1");
  });

  it.each([
    { name: "no counterparty", counterparty: null },
    { name: "payer never paid", counterparty: "Someone Else" },
  ])("is not a refund: $name", async ({ counterparty }) => {
    const s = await seeded();
    pay(s, "o1", 200_000);
    await s.handle(receipt({ ref: "f1", amount: 50_000, counterparty }));
    expect(s.store.get("u1")!.transactions.some((t) => t.transactionType === "refund")).toBe(false);
    expect(balanceOf(s).spentVnd).toBe(200_000);
  });

  it("an original paid after the refund is not linked", async () => {
    const s = await seeded();
    pay(s, "o1", 200_000, "2026-03-07T10:00:00Z");
    await s.handle(receipt({ ref: "f1", amount: 50_000 }));
    expect(s.store.get("u1")!.transactions.some((t) => t.transactionType === "refund")).toBe(false);
  });

  it("is idempotent and retries a failed publish without booking twice", async () => {
    const s = await seeded();
    pay(s, "o1", 200_000);
    const ev = receipt({ ref: "f1", amount: 300_000 });
    s.fail.publish = true;
    await expect(s.handle(ev)).rejects.toThrow("bus down");
    s.fail.publish = false;
    await s.handle(ev);
    await s.handle(ev);
    const rec = s.store.get("u1")!;
    expect(rec.transactions.filter((t) => t.transactionType === "refund")).toHaveLength(1);
    expect(rec.incomePool).toHaveLength(1);
    expect(types(s, "txn.recorded")).toHaveLength(1);
    expect(types(s, "income.recorded")).toHaveLength(1);
    expect(balanceOf(s).spentVnd).toBe(0);
  });

  it("records nothing when the cycle is not running", async () => {
    const s = await seeded();
    pay(s, "o1", 200_000);
    s.store.get("u1")!.cycle.state = "awaiting_funds";
    await s.handle(receipt({ ref: "f1", amount: 50_000 }));
    expect(s.store.get("u1")!.transactions).toHaveLength(1);
  });
});

describe("refund of an original in an earlier cycle", () => {
  it("never makes spent negative: the whole refund is income", async () => {
    const s = await seeded();
    pay(s, "o1", 200_000);
    s.store.get("u1")!.transactions[0]!.cycleId = "earlier-cycle";
    expect(balanceOf(s).spentVnd).toBe(0);

    await s.handle(receipt({ ref: "f1", amount: 150_000 }));

    const rec = s.store.get("u1")!;
    const txn = rec.transactions.find((t) => t.bankTransactionRef === "f1")!;
    expect(txn).toMatchObject({ transactionType: "refund", restoredVnd: 0 });
    expect(txn.refundOfTransactionId).toBe("orig-o1");
    expect(balanceOf(s).spentVnd).toBe(0);
    expect(balanceOf(s).balanceVnd).toBe(s.category.cycleLimitVnd);
    expect(rec.incomePool.map((e) => e.amountVnd)).toEqual([150_000]);
    // The closed period is never edited.
    expect(rec.transactions[0]!.amountVnd).toBe(200_000);
  });
});

describe("internal transfer wiring (criterion 2)", () => {
  const noCategoryChange = (s: S) =>
    expect(getCategoryBalances(s.store.get("u1")!).every((b) => b.spentVnd === 0)).toBe(true);

  it("pairs an out leg and an in leg of own accounts into internal transfers", async () => {
    const s = await seeded();
    await s.handle(leg({ ref: "x1", amount: 500_000, direction: "out", hint: "MAIN" }));
    expect(s.store.get("u1")!.transactions).toHaveLength(0);
    await s.handle(
      leg({
        ref: "x2",
        amount: 500_000,
        direction: "in",
        hint: "SAV",
        at: "2026-03-05T10:20:00Z",
      }),
    );
    const rec = s.store.get("u1")!;
    expect(rec.transactions.map((t) => t.transactionType)).toEqual([
      "internal_transfer",
      "internal_transfer",
    ]);
    expect(rec.transactions.every((t) => t.reconciliationResult === "internal_transfer")).toBe(
      true,
    );
    expect(rec.transactions.every((t) => t.categoryId === null)).toBe(true);
    expect(rec.incomePool).toHaveLength(0);
    noCategoryChange(s);
    expect(types(s, "txn.recorded")).toHaveLength(2);
    expect(rec.pendingLegs).toHaveLength(0);
  });

  it("pairs when the in leg arrives first", async () => {
    const s = await seeded();
    await s.handle(leg({ ref: "x2", amount: 500_000, direction: "in", hint: "SAV" }));
    await s.handle(leg({ ref: "x1", amount: 500_000, direction: "out", hint: "MAIN" }));
    expect(s.store.get("u1")!.transactions).toHaveLength(2);
  });

  it("books a leg with the MW-DC memo at once", async () => {
    const s = await seeded();
    await s.handle(
      leg({ ref: "x1", amount: 500_000, direction: "out", hint: "MAIN", memo: "MW-DC-MAIN-SAV" }),
    );
    const t = s.store.get("u1")!.transactions;
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ transactionType: "internal_transfer", categoryId: null });
    noCategoryChange(s);
  });

  it("ignores an MW-DC memo naming an undeclared account", async () => {
    const s = await seeded();
    await s.handle(
      leg({ ref: "x1", amount: 500_000, direction: "out", hint: "MAIN", memo: "MW-DC-MAIN-XXX" }),
    );
    expect(s.store.get("u1")!.transactions).toHaveLength(0);
  });

  it.each([
    { name: "different amount", amount2: 499_000, at2: "2026-03-05T10:20:00Z", hint2: "SAV" },
    { name: "outside the window", amount2: 500_000, at2: "2026-03-05T11:30:00Z", hint2: "SAV" },
    { name: "same account", amount2: 500_000, at2: "2026-03-05T10:20:00Z", hint2: "MAIN" },
    { name: "undeclared account", amount2: 500_000, at2: "2026-03-05T10:20:00Z", hint2: "OTHER" },
  ])("does not pair: $name", async ({ amount2, at2, hint2 }) => {
    const s = await seeded();
    await s.handle(leg({ ref: "x1", amount: 500_000, direction: "out", hint: "MAIN" }));
    await s.handle(leg({ ref: "x2", amount: amount2, direction: "in", hint: hint2, at: at2 }));
    expect(s.store.get("u1")!.transactions).toHaveLength(0);
  });

  it("uses the window from the user setting", async () => {
    const s = await seeded({ "budget.internal_transfer_match_window_minutes": 120 });
    await s.handle(leg({ ref: "x1", amount: 500_000, direction: "out", hint: "MAIN" }));
    await s.handle(
      leg({
        ref: "x2",
        amount: 500_000,
        direction: "in",
        hint: "SAV",
        at: "2026-03-05T11:30:00Z",
      }),
    );
    expect(s.store.get("u1")!.transactions).toHaveLength(2);
  });

  it("is idempotent per receipt", async () => {
    const s = await seeded();
    const a = leg({ ref: "x1", amount: 500_000, direction: "out", hint: "MAIN" });
    const b = leg({ ref: "x2", amount: 500_000, direction: "in", hint: "SAV" });
    for (const e of [a, a, b, b, a]) await s.handle(e);
    expect(s.store.get("u1")!.transactions).toHaveLength(2);
    expect(types(s, "txn.recorded")).toHaveLength(2);
  });
});
