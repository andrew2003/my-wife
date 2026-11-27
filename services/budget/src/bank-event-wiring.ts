import {
  SETTINGS,
  type BudgetCategory,
  type EventEnvelope,
  type Locale,
  type SettingKey,
} from "@my-wife/contracts";
import { BANK_FEES_SHORT_CODE, cashAllocationDeadline, classifyBankEvent } from "./bank-events";
import { t } from "./i18n";
import type { SampleBudgetStore } from "./onboarding";
import type { TransactionRecord } from "./transactions";

export interface BankEventDeps {
  store: SampleBudgetStore;
  locale: Locale;
  now: () => Date;
  newId: () => string;
  publish: (event: EventEnvelope) => void | Promise<void>;
  readSettings?: (userId: string) => Promise<Partial<Record<SettingKey, unknown>>>;
}

/** Deadline from the user's settings; an invalid or missing value falls back to the default. */
export function cashDeadlineHoursFromSettings(
  settings: Partial<Record<SettingKey, unknown>>,
): number {
  const value = settings["budget.cash_allocation_deadline_hours"];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1
    ? value
    : SETTINGS["budget.cash_allocation_deadline_hours"].default;
}

/**
 * Handles `receipt.parsed` for cash withdrawals and bank fees (spec 10 section 5), after the
 * coded and planned rules and before the refund and transfer rules. Booked once per
 * `bankTransactionRef` with an audit record.
 *
 * - An ATM or counter withdrawal is held as unallocated cash: type `cash_withdrawal`, no
 *   category, so it counts against no category until the user allocates it; the allocation
 *   deadline comes from `budget.cash_allocation_deadline_hours`.
 * - A fee or interest charge is booked automatically to the bank fees category (created on the
 *   first fee when the user has none), type `bank_fee`.
 */
export function createBankEventHandler(deps: BankEventDeps) {
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

  return async function onBankEvent(event: EventEnvelope): Promise<void> {
    if (event.type !== "receipt.parsed") return;
    const { payload } = event as EventEnvelope<"receipt.parsed">;
    const userId = event.userId;
    const record = await deps.store.find(userId);
    if (!record || record.cycle.state !== "running") return;

    const existing = record.transactions.find(
      (x) => x.bankTransactionRef === payload.bankTransactionRef,
    );
    if (existing) {
      const mine =
        existing.transactionType === "cash_withdrawal" || existing.transactionType === "bank_fee";
      if (mine && !existing.announced) await announce(userId, existing);
      return;
    }

    if (payload.amountVnd <= 0) return;
    const kind = classifyBankEvent(payload);
    const hint = payload.bankAccountHint.trim().toUpperCase();
    const account = record.accounts.find((a) => a.code.toUpperCase() === hint);
    if (!kind || !account) return;

    let newCategory: BudgetCategory | undefined;
    let categoryId: string | null = null;
    let allocationDeadlineAt: string | undefined;
    if (kind === "bank_fee") {
      const found = record.categories.find((c) => c.shortCode === BANK_FEES_SHORT_CODE);
      const spending = record.accounts.find((a) => a.kind === "spending") ?? account;
      newCategory = found
        ? undefined
        : {
            id: `bank-fees-${userId}`,
            name: t("budget.category.bank_fees", deps.locale),
            shortCode: BANK_FEES_SHORT_CODE,
            // A fund category with no limit never causes an overspend penalty: a bank fee is
            // not the user's fault.
            priority: "fund",
            kind: "variable",
            countsTowardSurplus: false,
            bankAccountId: spending.id,
            cycleLimitVnd: 0,
            wantOrder: null,
          };
      categoryId = found?.id ?? newCategory!.id;
    } else {
      const settings = (await deps.readSettings?.(userId)) ?? {};
      allocationDeadlineAt = cashAllocationDeadline(
        payload.occurredAt,
        cashDeadlineHoursFromSettings(settings),
      );
    }

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
      transactionType: kind,
      // A fee is fixed by the bank and a withdrawal awaits allocation: neither was planned.
      reconciliationResult: kind === "bank_fee" ? "unplanned" : "unknown",
      categoryId,
      ...(allocationDeadlineAt ? { allocationDeadlineAt } : {}),
      announced: false,
    };
    const result = await deps.store.recordTransaction(
      userId,
      record.cycle.id,
      txn,
      deps.now(),
      undefined,
      newCategory,
    );
    if (result === "recorded") await announce(userId, txn);
  };
}
