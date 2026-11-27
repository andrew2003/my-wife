import { describe, expect, it } from "vitest";
import { getCategoryBalances, type TransactionRecord } from "../src/transactions";
import { bookRefund, isInternalTransferPair, type PairLeg } from "../src/refunds";

const refundCases = [
  { name: "refund above original: excess is income", original: 200_000, restored: 0, refund: 300_000, out: { restoredVnd: 200_000, incomeVnd: 100_000 } },
  { name: "refund equal to original", original: 200_000, restored: 0, refund: 200_000, out: { restoredVnd: 200_000, incomeVnd: 0 } },
  { name: "partial refund", original: 200_000, restored: 0, refund: 50_000, out: { restoredVnd: 50_000, incomeVnd: 0 } },
  { name: "second refund capped by what is left", original: 200_000, restored: 150_000, refund: 100_000, out: { restoredVnd: 50_000, incomeVnd: 50_000 } },
  { name: "original already fully restored", original: 200_000, restored: 200_000, refund: 10_000, out: { restoredVnd: 0, incomeVnd: 10_000 } },
  { name: "one VND over", original: 200_000, restored: 0, refund: 200_001, out: { restoredVnd: 200_000, incomeVnd: 1 } },
  { name: "zero refund", original: 200_000, restored: 0, refund: 0, out: { restoredVnd: 0, incomeVnd: 0 } },
];

describe("bookRefund", () => {
  it.each(refundCases)("$name", ({ original, restored, refund, out }) => {
    expect(
      bookRefund({ originalVnd: original, alreadyRestoredVnd: restored, refundVnd: refund }),
    ).toEqual(out);
  });
});

const T0 = "2026-03-05T10:00:00Z";
const leg = (o: Partial<PairLeg>): PairLeg => ({
  accountId: "a",
  direction: "out",
  amountVnd: 500_000,
  occurredAt: T0,
  ...o,
});
const own = ["a", "b"];
const pairCases = [
  { name: "paired own accounts", out: leg({}), inn: leg({ accountId: "b", direction: "in" }), ok: true },
  { name: "exactly at window edge", out: leg({}), inn: leg({ accountId: "b", direction: "in", occurredAt: "2026-03-05T11:00:00Z" }), ok: true },
  { name: "one second past window", out: leg({}), inn: leg({ accountId: "b", direction: "in", occurredAt: "2026-03-05T11:00:01Z" }), ok: false },
  { name: "different amount", out: leg({}), inn: leg({ accountId: "b", direction: "in", amountVnd: 499_999 }), ok: false },
  { name: "same account", out: leg({}), inn: leg({ direction: "in" }), ok: false },
  { name: "undeclared account", out: leg({}), inn: leg({ accountId: "x", direction: "in" }), ok: false },
  { name: "wrong directions", out: leg({ direction: "in" }), inn: leg({ accountId: "b", direction: "in" }), ok: false },
];
describe("isInternalTransferPair", () => {
  it.each(pairCases)("$name", ({ out, inn, ok }) => {
    expect(isInternalTransferPair(out, inn, own, 60)).toBe(ok);
  });
});

const txn = (o: Partial<TransactionRecord>): TransactionRecord => ({
  id: "t",
  cycleId: "c1",
  receiptId: "r",
  bankTransactionRef: "ref",
  bankAccountId: "a",
  direction: "out",
  amountVnd: 200_000,
  occurredAt: T0,
  memo: "",
  counterparty: null,
  transactionType: "coded_unplanned",
  reconciliationResult: "unplanned",
  categoryId: "cat",
  announced: true,
  ...o,
});
const rec = (transactions: TransactionRecord[]) =>
  ({
    cycle: { id: "c1" },
    categories: [{ id: "cat", cycleLimitVnd: 1_000_000 }],
    transactions,
  }) as unknown as Parameters<typeof getCategoryBalances>[0];

describe("category balances", () => {
  it("refund of 300,000 on 200,000 returns 200,000 to the category", () => {
    const b = getCategoryBalances(
      rec([
        txn({}),
        txn({ id: "t2", direction: "in", amountVnd: 300_000, transactionType: "refund", restoredVnd: 200_000 }),
      ]),
    )[0]!;
    expect(b.spentVnd).toBe(0);
    expect(b.balanceVnd).toBe(1_000_000);
  });
  it("internal transfer changes no category", () => {
    const before = getCategoryBalances(rec([txn({})]))[0]!;
    const after = getCategoryBalances(
      rec([
        txn({}),
        txn({ id: "i1", amountVnd: 500_000, transactionType: "internal_transfer", reconciliationResult: "internal_transfer" }),
        txn({ id: "i2", direction: "in", amountVnd: 500_000, transactionType: "internal_transfer", reconciliationResult: "internal_transfer" }),
      ]),
    )[0]!;
    expect(after).toEqual(before);
  });
});
