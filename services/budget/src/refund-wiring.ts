import { SETTINGS, type EventEnvelope, type SettingKey } from "@my-wife/contracts";
import {
  findRefundOriginal,
  isInternalTransferPair,
  parseInternalTransferMemo,
  splitRefund,
  type PairLeg,
} from "./refunds";
import type {
  IncomePoolEntry,
  PendingLeg,
  SampleBudgetRecord,
  SampleBudgetStore,
} from "./onboarding";
import type { TransactionRecord } from "./transactions";

export interface RefundTransferDeps {
  store: SampleBudgetStore;
  now: () => Date;
  newId: () => string;
  publish: (event: EventEnvelope) => void | Promise<void>;
  readSettings?: (userId: string) => Promise<Partial<Record<SettingKey, unknown>>>;
}

/** Match window from the user's settings; an invalid or missing value falls back to the default. */
export function matchWindowFromSettings(settings: Partial<Record<SettingKey, unknown>>): number {
  const value = settings["budget.internal_transfer_match_window_minutes"];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1
    ? value
    : SETTINGS["budget.internal_transfer_match_window_minutes"].default;
}

/**
 * Handles `receipt.parsed` for refunds and internal transfers (spec 10 section 5), after the
 * coded and planned rules had their turn. Everything is booked once per `bankTransactionRef`
 * with an audit record; `txn.recorded` and `income.recorded` use deterministic ids and a failed
 * publish is retried by the next delivery of the same receipt.
 *
 * - Own accounts: a `MW-DC-<from>-<to>` memo, or an out leg and an in leg of two declared
 *   accounts with an equal amount inside the match window, become `internal_transfer`
 *   transactions with no category. A leg waiting for its pair is held.
 * - Incoming money from a counterparty previously paid is a `refund` linked to the original.
 *   Up to the original amount returns to the category; the excess goes to the income pool. An
 *   original of an earlier cycle restores nothing and the whole refund is income.
 */
export function createRefundTransferHandler(deps: RefundTransferDeps) {
  const announceTxn = async (userId: string, txn: TransactionRecord) => {
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

  const announceIncome = async (userId: string, entry: IncomePoolEntry) => {
    await deps.publish({
      id: `income-recorded-${entry.id}`,
      type: "income.recorded",
      occurredAt: entry.receivedAt,
      userId,
      schemaVersion: 1,
      payload: { entryId: entry.id, amountVnd: entry.amountVnd, payer: entry.payer },
    } as EventEnvelope);
    await deps.store.markIncomeAnnounced(userId, entry.id);
  };

  /** Publishes what an earlier delivery booked but could not announce. */
  async function announcePending(userId: string, record: SampleBudgetRecord, txnId: string) {
    const txn = record.transactions.find((t) => t.id === txnId);
    if (txn && !txn.announced) await announceTxn(userId, txn);
    for (const entry of record.incomePool) {
      if (entry.sourceTransactionId === txnId && !entry.announced) {
        await announceIncome(userId, entry);
      }
    }
  }

  const legTxn = (
    leg: PendingLeg,
    cycleId: string,
    counterparty: string | null,
    id: string,
  ): TransactionRecord => ({
    id,
    cycleId,
    receiptId: leg.receiptId,
    bankTransactionRef: leg.bankTransactionRef,
    bankAccountId: leg.bankAccountId,
    direction: leg.direction,
    amountVnd: leg.amountVnd,
    occurredAt: leg.occurredAt,
    memo: leg.memo,
    counterparty,
    transactionType: "internal_transfer",
    reconciliationResult: "internal_transfer",
    categoryId: null,
    announced: false,
  });

  return async function onRefundOrTransfer(event: EventEnvelope): Promise<void> {
    if (event.type !== "receipt.parsed") return;
    const { payload } = event as EventEnvelope<"receipt.parsed">;
    const userId = event.userId;
    const record = await deps.store.find(userId);
    if (!record || record.cycle.state !== "running") return;

    const existing = record.transactions.find(
      (t) => t.bankTransactionRef === payload.bankTransactionRef,
    );
    if (existing) {
      if (
        existing.transactionType === "refund" ||
        existing.transactionType === "internal_transfer"
      ) {
        await announcePending(userId, record, existing.id);
      }
      return;
    }

    const hint = payload.bankAccountHint.trim().toUpperCase();
    const account = record.accounts.find((a) => a.code.toUpperCase() === hint);
    if (!account || payload.amountVnd <= 0) return;
    const cycleId = record.cycle.id;
    const leg: PendingLeg = {
      receiptId: payload.receiptId,
      bankTransactionRef: payload.bankTransactionRef,
      bankAccountId: account.id,
      direction: payload.direction,
      amountVnd: payload.amountVnd,
      occurredAt: payload.occurredAt,
      memo: payload.memo,
    };

    const bookTransfer = async (legs: { leg: PendingLeg; id: string }[]) => {
      const txns = legs.map((l) => legTxn(l.leg, cycleId, null, l.id));
      const result = await deps.store.recordInternalTransfer(userId, cycleId, txns, deps.now());
      if (result !== "recorded") return;
      for (const txn of txns) await announceTxn(userId, txn);
    };

    // A leg whose memo names two declared own accounts is an internal transfer on its own.
    const named = parseInternalTransferMemo(payload.memo);
    if (named) {
      const from = record.accounts.find((a) => a.code.toUpperCase() === named.from);
      const to = record.accounts.find((a) => a.code.toUpperCase() === named.to);
      if (from && to && from.id !== to.id) {
        const mine = payload.direction === "out" ? from.id : to.id;
        if (account.id === mine) {
          await bookTransfer([{ leg, id: deps.newId() }]);
          return;
        }
      }
    }

    // A held opposite leg of another own account completes the pair.
    const settings = (await deps.readSettings?.(userId)) ?? {};
    const windowMinutes = matchWindowFromSettings(settings);
    const ownIds = record.accounts.map((a) => a.id);
    const asPair = (l: PendingLeg): PairLeg => ({
      accountId: l.bankAccountId,
      direction: l.direction,
      amountVnd: l.amountVnd,
      occurredAt: l.occurredAt,
    });
    const partner = record.pendingLegs.find((held) =>
      leg.direction === "in"
        ? isInternalTransferPair(asPair(held), asPair(leg), ownIds, windowMinutes)
        : isInternalTransferPair(asPair(leg), asPair(held), ownIds, windowMinutes),
    );
    if (partner) {
      await bookTransfer([
        { leg: partner, id: deps.newId() },
        { leg, id: deps.newId() },
      ]);
      return;
    }

    if (payload.direction === "in") {
      const found = findRefundOriginal(payload, record.transactions);
      if (found) {
        const { original, alreadyRestoredVnd } = found;
        const split = splitRefund({
          originalVnd: original.amountVnd,
          alreadyRestoredVnd,
          refundVnd: payload.amountVnd,
          sameCycle: original.cycleId === cycleId,
        });
        const txn: TransactionRecord = {
          ...legTxn(leg, cycleId, payload.counterparty, deps.newId()),
          transactionType: "refund",
          reconciliationResult: "adjusted",
          categoryId: original.categoryId,
          refundOfTransactionId: original.id,
          restoredVnd: split.restoredVnd,
        };
        const income: IncomePoolEntry | undefined =
          split.incomeVnd > 0
            ? {
                id: `income-${txn.id}`,
                amountVnd: split.incomeVnd,
                payer: payload.counterparty ?? "",
                receivedAt: payload.occurredAt,
                sourceTransactionId: txn.id,
                allocatedCycleId: null,
                announced: false,
              }
            : undefined;
        const result = await deps.store.recordTransaction(userId, cycleId, txn, deps.now(), income);
        if (result !== "recorded") return;
        await announceTxn(userId, txn);
        if (income) await announceIncome(userId, income);
        return;
      }
    }

    // Not classified here: keep the leg in case its pair arrives later.
    await deps.store.holdLeg(userId, leg);
  };
}
