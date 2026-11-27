/** Foreign card payments (spec 10 section 5, `foreign_card`). Integer VND only. */
import type { EventEnvelope } from "@my-wife/contracts";
import type { SampleBudgetStore } from "./onboarding";
import type { TransactionRecord } from "./transactions";

/** The local currency; a receipt in any other currency is a foreign card payment. */
const LOCAL_CURRENCY = "VND";

/**
 * Port to the pluggable FX provider. It is reserved for provisional bookings (a debit without a
 * VND amount, follow-up of #215) and is never called when the email carries the VND amount.
 */
export type FxProvider = (currency: string, at: Date) => Promise<number>;

export interface ForeignCardReceipt {
  direction: "in" | "out";
  amountVnd: number;
  currency: string;
}

/**
 * Pure: an outgoing receipt in a foreign currency that carries its VND amount. The VND amount
 * from the email always wins, so no rate is needed for such a receipt.
 */
export function isForeignCardReceipt(receipt: ForeignCardReceipt): boolean {
  return (
    receipt.direction === "out" &&
    receipt.amountVnd > 0 &&
    receipt.currency.toUpperCase() !== LOCAL_CURRENCY
  );
}

export interface ForeignCardDeps {
  store: SampleBudgetStore;
  now: () => Date;
  newId: () => string;
  publish: (event: EventEnvelope) => void | Promise<void>;
  fxProvider?: FxProvider;
}

/**
 * Handles `receipt.parsed` for foreign card payments, after the coded, planned and bank-event
 * rules. Books type `foreign_card` with the VND amount of the email (never converted), keeps the
 * foreign currency and amount for the audit trail, and leaves the category unassigned
 * (`unknown`) until the user or a learned merchant rule assigns it. Once per `bankTransactionRef`.
 */
export function createForeignCardHandler(deps: ForeignCardDeps) {
  const announce = async (userId: string, txn: TransactionRecord) => {
    await deps.publish({
      id: `txn-recorded-${txn.id}`,
      type: "txn.recorded",
      occurredAt: txn.occurredAt,
      userId,
      schemaVersion: 1,
      payload: {
        transactionId: txn.id,
        cycleId: txn.cycleId,
        amountVnd: txn.amountVnd,
        direction: txn.direction,
        transactionType: txn.transactionType,
        reconciliationResult: txn.reconciliationResult,
        categoryId: txn.categoryId,
        bankAccountId: txn.bankAccountId,
        memo: txn.memo,
      },
    } as EventEnvelope);
    await deps.store.markTransactionAnnounced(userId, txn.id);
  };

  return async function onForeignCard(event: EventEnvelope): Promise<void> {
    if (event.type !== "receipt.parsed") return;
    const { payload } = event as EventEnvelope<"receipt.parsed">;
    const userId = event.userId;
    const record = await deps.store.find(userId);
    if (!record || record.cycle.state !== "running") return;

    const existing = record.transactions.find(
      (x) => x.bankTransactionRef === payload.bankTransactionRef,
    );
    if (existing) {
      if (existing.transactionType === "foreign_card" && !existing.announced) {
        await announce(userId, existing);
      }
      return;
    }
    if (!isForeignCardReceipt(payload)) return;
    const hint = payload.bankAccountHint.trim().toUpperCase();
    const account = record.accounts.find((a) => a.code.toUpperCase() === hint);
    if (!account) return;

    const txn: TransactionRecord = {
      id: deps.newId(),
      cycleId: record.cycle.id,
      receiptId: payload.receiptId,
      bankTransactionRef: payload.bankTransactionRef,
      bankAccountId: account.id,
      direction: "out",
      amountVnd: payload.amountVnd,
      occurredAt: payload.occurredAt,
      memo: payload.memo,
      counterparty: payload.counterparty,
      transactionType: "foreign_card",
      reconciliationResult: "unknown",
      categoryId: null,
      currency: payload.currency.toUpperCase(),
      ...(payload.foreignAmountMinor === undefined
        ? {}
        : { foreignAmountMinor: payload.foreignAmountMinor }),
      announced: false,
    };
    const result = await deps.store.recordTransaction(userId, record.cycle.id, txn, deps.now());
    if (result === "recorded") await announce(userId, txn);
  };
}
