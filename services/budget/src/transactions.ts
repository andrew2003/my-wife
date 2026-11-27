import {
  SETTINGS,
  type EventEnvelope,
  type ReconciliationResult,
  type SettingKey,
  type TransactionType,
} from "@my-wife/contracts";
import type { SampleBudgetRecord, SampleBudgetStore } from "./onboarding";
import { reconcilePlannedTransfer, type ToleranceSettings } from "./reconciliation";
import { matchTransferCode, normalizeMemo } from "./transfer-codes";

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
  reconciliationResult: ReconciliationResult;
  /** Null for an internal transfer, which never touches a category. */
  categoryId: string | null;
  /** Set when the receipt carried the code of a planned item. */
  plannedItemId?: string;
  /** Refund only: the original outgoing transaction it is linked to. */
  refundOfTransactionId?: string;
  /** Refund only: the part returned to the category limit (see `bookRefund`). */
  restoredVnd?: number;
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
    const inCategory = record.transactions.filter(
      (t) =>
        t.cycleId === record.cycle.id &&
        t.categoryId === c.id &&
        t.transactionType !== "internal_transfer",
    );
    const outVnd = inCategory
      .filter((t) => t.direction === "out")
      .reduce((sum, t) => sum + t.amountVnd, 0);
    // A refund restores spent only when its original is spent in this cycle; one linked to an
    // earlier cycle (closed, never edited) would drive spent below zero.
    const restoredVnd = inCategory
      .filter(
        (t) =>
          t.transactionType === "refund" &&
          (!t.refundOfTransactionId || inCategory.some((o) => o.id === t.refundOfTransactionId)),
      )
      .reduce((sum, t) => sum + (t.restoredVnd ?? 0), 0);
    const spentVnd = outVnd - restoredVnd;
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
  readSettings?: (userId: string) => Promise<Partial<Record<SettingKey, unknown>>>;
}

/** Tolerance from the user's settings; an invalid or missing value falls back to the default. */
export function toleranceFromSettings(
  settings: Partial<Record<SettingKey, unknown>>,
): ToleranceSettings {
  const percent = settings["budget.tolerance_percent"];
  const minVnd = settings["budget.tolerance_min_vnd"];
  return {
    percent:
      typeof percent === "number" && Number.isFinite(percent) && percent >= 0 && percent <= 100
        ? percent
        : SETTINGS["budget.tolerance_percent"].default,
    minVnd:
      typeof minVnd === "number" && Number.isSafeInteger(minVnd) && minVnd >= 0
        ? minVnd
        : SETTINGS["budget.tolerance_min_vnd"].default,
  };
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

  /**
   * A receipt whose memo holds the code of a not yet matched planned item is reconciled with the
   * tolerance settings. The paying account must resolve from the hint, otherwise undefined.
   */
  async function matchPlannedItem(
    userId: string,
    record: SampleBudgetRecord,
    receipt: CodedTransferReceipt,
  ) {
    if (receipt.direction !== "out" || receipt.amountVnd <= 0) return undefined;
    const open = record.plannedItems.filter((i) => i.status !== "matched");
    const code = matchTransferCode(
      receipt.memo,
      open.map((i) => i.transferCode),
    );
    const item = open.find((i) => i.transferCode === code);
    const category = item && record.categories.find((c) => c.id === item.categoryId);
    const hint = receipt.bankAccountHint.trim().toUpperCase();
    const account = record.accounts.find((a) => a.code.toUpperCase() === hint);
    if (!item || !category || !account) return undefined;
    const settings = (await deps.readSettings?.(userId)) ?? {};
    return {
      transactionType: "planned_transfer" as const,
      reconciliationResult: reconcilePlannedTransfer({
        plannedVnd: item.amountVnd,
        amountVnd: receipt.amountVnd,
        tolerance: toleranceFromSettings(settings),
        payingAccountId: account.id,
        categoryAccountId: category.bankAccountId,
      }),
      categoryId: category.id,
      bankAccountId: account.id,
      plannedItemId: item.id,
    };
  }

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

    const found =
      (await matchPlannedItem(event.userId, record, payload)) ??
      classifyCodedTransfer(payload, record.categories, record.accounts);
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
      ...("plannedItemId" in found ? { plannedItemId: found.plannedItemId } : {}),
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
