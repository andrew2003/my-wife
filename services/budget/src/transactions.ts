import type { EventEnvelope, TransactionType } from "@my-wife/contracts";
import type { SampleBudgetRecord, SampleBudgetStore } from "./onboarding";
import { normalizeMemo } from "./transfer-codes";

/** A transaction booked by `budget` (spec 10 section 5). Integer VND only. */
export interface TransactionRecord {
  id: string;
  cycleId: string;
  receiptId: string;
  bankTransactionRef: string;
  bankAccountId: string;
  direction: "in" | "out";
  amountVnd: number;
  occurredAt: string;
  memo: string;
  counterparty: string | null;
  transactionType: TransactionType;
  reconciliationResult: "unplanned" | "unknown";
  categoryId: string;
  /** False until `txn.recorded` was published, so a failed publish is retried. */
  announced: boolean;
}

export interface CodedTransferReceipt {
  direction: "in" | "out";
  amountVnd: number;
  memo: string;
  bankAccountHint: string;
}

export interface Classification {
  transactionType: "coded_unplanned";
  reconciliationResult: "unplanned";
  categoryId: string;
  bankAccountId: string;
}

/**
 * Pure: classifies an outgoing receipt whose whole memo is a category short code (spec 10
 * section 5, `coded_unplanned`). The memo is normalized, never parsed as free text. The paying
 * account must resolve from the hint (account code, case-insensitive); otherwise undefined.
 * Items with an issued planned-item code are a separate rule and are not matched here.
 */
export function classifyCodedTransfer(
  receipt: CodedTransferReceipt,
  categories: readonly { id: string; shortCode: string }[],
  accounts: readonly { id: string; code: string }[],
): Classification | undefined {
  if (receipt.direction !== "out" || receipt.amountVnd <= 0) return undefined;
  const memo = normalizeMemo(receipt.memo);
  if (memo === "") return undefined;
  const category = categories.find((c) => normalizeMemo(c.shortCode) === memo);
  const hint = receipt.bankAccountHint.trim().toUpperCase();
  const account = accounts.find((a) => a.code.toUpperCase() === hint);
  if (!category || !account) return undefined;
  return {
    transactionType: "coded_unplanned",
    reconciliationResult: "unplanned",
    categoryId: category.id,
    bankAccountId: account.id,
  };
}

export interface CategoryBalance {
  categoryId: string;
  limitVnd: number;
  spentVnd: number;
  /** Cycle limit minus spent; negative when overspent. */
  balanceVnd: number;
}

/** Pure: per category cycle limit, outgoing transactions of the current cycle and the balance. */
export function getCategoryBalances(
  record: Pick<SampleBudgetRecord, "cycle" | "categories" | "transactions">,
): CategoryBalance[] {
  return record.categories.map((c) => {
    const spentVnd = record.transactions
      .filter(
        (t) => t.cycleId === record.cycle.id && t.categoryId === c.id && t.direction === "out",
      )
      .reduce((sum, t) => sum + t.amountVnd, 0);
    return {
      categoryId: c.id,
      limitVnd: c.cycleLimitVnd,
      spentVnd,
      balanceVnd: c.cycleLimitVnd - spentVnd,
    };
  });
}

export interface TransactionDeps {
  store: SampleBudgetStore;
  now: () => Date;
  newId: () => string;
  publish: (event: EventEnvelope) => void | Promise<void>;
}

/**
 * Handles `receipt.parsed` for a `running` cycle: a coded transfer is booked once per
 * `bankTransactionRef` (idempotent) with an audit record, then `txn.recorded` is published with
 * the deterministic id `txn-recorded-<transactionId>`. A failed publish is retried by the next
 * delivery of the same receipt, never by booking twice.
 */
export function createTransactionHandler(deps: TransactionDeps) {
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

  return async function onTransactionReceipt(event: EventEnvelope): Promise<void> {
    if (event.type !== "receipt.parsed") return;
    const { payload } = event as EventEnvelope<"receipt.parsed">;
    const record = await deps.store.find(event.userId);
    if (!record || record.cycle.state !== "running") return;

    const existing = record.transactions.find(
      (t) => t.bankTransactionRef === payload.bankTransactionRef,
    );
    if (existing) {
      if (!existing.announced) await announce(event.userId, existing);
      return;
    }

    const found = classifyCodedTransfer(payload, record.categories, record.accounts);
    if (!found) return;

    const txn: TransactionRecord = {
      id: deps.newId(),
      cycleId: record.cycle.id,
      receiptId: payload.receiptId,
      bankTransactionRef: payload.bankTransactionRef,
      bankAccountId: found.bankAccountId,
      direction: payload.direction,
      amountVnd: payload.amountVnd,
      occurredAt: payload.occurredAt,
      memo: payload.memo,
      counterparty: payload.counterparty,
      transactionType: found.transactionType,
      reconciliationResult: found.reconciliationResult,
      categoryId: found.categoryId,
      announced: false,
    };
    const result = await deps.store.recordTransaction(
      event.userId,
      record.cycle.id,
      txn,
      deps.now(),
    );
    if (result === "recorded") await announce(event.userId, txn);
  };
}
