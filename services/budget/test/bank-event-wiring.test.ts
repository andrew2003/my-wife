import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "@my-wife/contracts";
import { createOnboardingHandler, MemorySampleBudgetStore } from "../src/onboarding";
import { createBankEventHandler } from "../src/bank-event-wiring";
import { createTransactionHandler, getCategoryBalances } from "../src/transactions";
import { createRefundTransferHandler } from "../src/refund-wiring";
import { BANK_FEES_SHORT_CODE, unallocatedCashVnd } from "../src/bank-events";

const NOW = new Date("2026-03-05T10:00:00Z");

function receipt(o: { ref: string; amount: number; memo: string; direction?: "in" | "out" }) {
  return {
    id: `ev-${o.ref}`,
    type: "receipt.parsed",
    occurredAt: NOW.toISOString(),
    userId: "u1",
    schemaVersion: 1,
    payload: {
      receiptId: `r-${o.ref}`,
      bankTransactionRef: o.ref,
      bankAccountHint: "MAIN",
      direction: o.direction ?? "out",
      amountVnd: o.amount,
      currency: "VND",
      counterparty: null,
      memo: o.memo,
      occurredAt: NOW.toISOString(),
      source: "email",
      fxProvisional: false,
    },
  } as unknown as EventEnvelope;
}

async function seeded(hours?: number) {
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
  const publish = (e: EventEnvelope) => void published.push(e);
  const bank = createBankEventHandler({
    store,
    locale: "en",
    now: () => NOW,
    newId,
    publish,
    readSettings: async () =>
      hours === undefined ? {} : { "budget.cash_allocation_deadline_hours": hours },
  });
  const coded = createTransactionHandler({ store, now: () => NOW, newId, publish });
  const refund = createRefundTransferHandler({ store, now: () => NOW, newId, publish });
  const handle = async (e: EventEnvelope) => {
    await coded(e);
    await bank(e);
    await refund(e);
  };
  return { store, handle, published };
}

describe("cash withdrawal", () => {
  it("is held as unallocated cash with no category", async () => {
    const s = await seeded();
    await s.handle(receipt({ ref: "T1", amount: 2_000_000, memo: "ATM withdrawal" }));
    const rec = s.store.get("u1")!;
    expect(rec.transactions).toHaveLength(1);
    expect(rec.transactions[0]).toMatchObject({
      transactionType: "cash_withdrawal",
      categoryId: null,
      allocationDeadlineAt: "2026-03-06T10:00:00.000Z",
    });
    expect(unallocatedCashVnd(rec.transactions)).toBe(2_000_000);
    expect(getCategoryBalances(rec).every((b) => b.spentVnd === 0)).toBe(true);
    expect(rec.pendingLegs).toHaveLength(0);
    expect(rec.audit.filter((a) => a.action === "transaction_recorded")).toHaveLength(1);
    expect(s.published.map((e) => e.type)).toEqual(["txn.recorded"]);
  });

  it("uses the user's allocation deadline setting", async () => {
    const s = await seeded(48);
    await s.handle(receipt({ ref: "T1", amount: 500_000, memo: "ATM" }));
    expect(s.store.get("u1")!.transactions[0]!.allocationDeadlineAt).toBe(
      "2026-03-07T10:00:00.000Z",
    );
  });

  it("is idempotent per bank transaction ref", async () => {
    const s = await seeded();
    const e = receipt({ ref: "T1", amount: 500_000, memo: "ATM" });
    await s.handle(e);
    await s.handle(e);
    expect(s.store.get("u1")!.transactions).toHaveLength(1);
    expect(s.published).toHaveLength(1);
  });
});

describe("bank fee", () => {
  it("is booked to the fees category, created once", async () => {
    const s = await seeded();
    await s.handle(receipt({ ref: "F1", amount: 11_000, memo: "Phí dịch vụ SMS" }));
    await s.handle(receipt({ ref: "F2", amount: 5_500, memo: "Annual fee" }));
    const rec = s.store.get("u1")!;
    const fees = rec.categories.filter((c) => c.shortCode === BANK_FEES_SHORT_CODE);
    expect(fees).toHaveLength(1);
    expect(fees[0]).toMatchObject({ name: "Bank fees", priority: "fund", cycleLimitVnd: 0 });
    expect(rec.transactions.map((t) => [t.transactionType, t.categoryId])).toEqual([
      ["bank_fee", fees[0]!.id],
      ["bank_fee", fees[0]!.id],
    ]);
    expect(getCategoryBalances(rec).find((b) => b.categoryId === fees[0]!.id)!.spentVnd).toBe(
      16_500,
    );
  });

  it("does not touch ordinary or incoming receipts", async () => {
    const s = await seeded();
    await s.handle(receipt({ ref: "X1", amount: 10_000, memo: "coffee" }));
    await s.handle(receipt({ ref: "X2", amount: 10_000, memo: "fee refund", direction: "in" }));
    expect(s.store.get("u1")!.transactions).toHaveLength(0);
  });
});
