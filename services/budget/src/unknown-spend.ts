import { SETTINGS, type EventEnvelope, type SettingKey } from "@my-wife/contracts";
import type { SampleBudgetRecord, SampleBudgetStore } from "./onboarding";
import { getCategoryBalances, type CategoryBalance, type TransactionRecord } from "./transactions";

/**
 * The facts of an unknown receipt that `budget` needs to book it. `receipt.unknown` carries only
 * the receipt id, so these come from ingest through `readReceipt` (see docs/decisions.md).
 */
export interface UnknownReceipt {
  bankTransactionRef: string;
  bankAccountHint: string;
  direction: "in" | "out";
  amountVnd: number;
  occurredAt: string;
  memo: string;
  counterparty: string | null;
}

/** Unknown spend opened as an anomaly (spec 10 section 7); money moves only on the answer. */
export interface AnomalyRecord {
  id: string;
  kind: "unknown_receipt";
  receiptId: string;
  cycleId: string;
  questionId: string;
  expiresAt: string;
  receipt: UnknownReceipt;
  state: "open" | "resolved";
  resolvedCategoryId: string | null;
  transactionId: string | null;
  /** False until `anomaly.opened` and `ask.budget_category` were published. */
  openedAnnounced: boolean;
  /** False until the resolution events were published. */
  resolvedAnnounced: boolean;
  /** True when the deadline booked it instead of an answer (spec 10 section 7). */
  resolvedByDeadline?: boolean;
}

export interface UnknownSpendDeps {
  store: SampleBudgetStore;
  now: () => Date;
  newId: () => string;
  publish: (event: EventEnvelope) => void | Promise<void>;
  /** Reads the receipt facts from ingest; undefined when it cannot be read. */
  readReceipt: (userId: string, receiptId: string) => Promise<UnknownReceipt | undefined>;
  readSettings?: (userId: string) => Promise<Partial<Record<SettingKey, unknown>>>;
}

const HOUR_MS = 3_600_000;
export const BUDGET_SOURCE = "budget";
export const ASK_KIND = "budget_category";

const resolutionOf = (a: AnomalyRecord) =>
  `${a.resolvedByDeadline ? "deadline:" : ""}category:${a.resolvedCategoryId}`;

function txnRecordedEvent(userId: string, txn: TransactionRecord): EventEnvelope {
  return {
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
  } as EventEnvelope;
}

function bookAnomalyTransaction(
  record: SampleBudgetRecord,
  anomaly: AnomalyRecord,
  category: { id: string; bankAccountId: string },
  id: string,
): TransactionRecord {
  const receipt = anomaly.receipt;
  const hint = receipt.bankAccountHint.trim().toUpperCase();
  const account = record.accounts.find((a) => a.code.toUpperCase() === hint);
  return {
    id,
    cycleId: anomaly.cycleId,
    receiptId: anomaly.receiptId,
    bankTransactionRef: receipt.bankTransactionRef,
    bankAccountId: account?.id ?? category.bankAccountId,
    direction: receipt.direction,
    amountVnd: receipt.amountVnd,
    occurredAt: receipt.occurredAt,
    memo: receipt.memo,
    counterparty: receipt.counterparty,
    transactionType: "unknown",
    reconciliationResult: "unknown",
    categoryId: category.id,
    announced: false,
  };
}

/**
 * Pure: the first `want` category (by `wantOrder`) whose remaining balance covers the amount,
 * else the first `want` category; undefined when the user has none (spec 10 section 7).
 */
export function pickWantCategory<
  C extends { id: string; priority: string; wantOrder: number | null },
>(categories: readonly C[], balances: readonly CategoryBalance[], amountVnd: number) {
  const wants = categories
    .filter((c) => c.priority === "want")
    .sort(
      (a, b) => (a.wantOrder ?? Number.MAX_SAFE_INTEGER) - (b.wantOrder ?? Number.MAX_SAFE_INTEGER),
    );
  const room = (c: C) =>
    (balances.find((b) => b.categoryId === c.id)?.balanceVnd ?? 0) >= amountVnd;
  return wants.find(room) ?? wants[0];
}

export interface UnknownDeadlineDeps {
  store: SampleBudgetStore;
  newId: () => string;
  publish: (event: EventEnvelope) => void | Promise<void>;
}

/**
 * Books every open unknown-spend anomaly of the user whose answer deadline (`expiresAt`, set from
 * `budget.unknown_deadline_hours` when it was opened) has passed, into the first `want` category
 * with room. Time is a parameter. It resolves the anomaly like an answer would (audit record, then
 * `txn.recorded` and `anomaly.resolved` with resolution `deadline:category:<id>`, which tells the
 * user); a failed publish is retried by the next run. With no `want` category nothing is booked.
 */
export function createUnknownDeadlineJob(deps: UnknownDeadlineDeps) {
  async function run(userId: string, now: Date): Promise<{ booked: number }> {
    const record = await deps.store.find(userId);
    if (!record) return { booked: 0 };
    let booked = 0;
    for (const anomaly of record.anomalies) {
      if (anomaly.state !== "open" || Date.parse(anomaly.expiresAt) > now.getTime()) continue;
      const category = pickWantCategory(
        record.categories,
        getCategoryBalances(record),
        anomaly.receipt.amountVnd,
      );
      if (!category) continue;
      const txn = bookAnomalyTransaction(record, anomaly, category, deps.newId());
      const result = await deps.store.resolveAnomaly(
        userId,
        anomaly.id,
        category.id,
        txn,
        now,
        "deadline",
      );
      if (result === "resolved") booked += 1;
    }
    // Also owed events of an earlier run whose publish failed.
    const fresh = await deps.store.find(userId);
    for (const a of fresh?.anomalies ?? []) {
      if (a.state !== "resolved" || a.resolvedAnnounced || !a.resolvedByDeadline) continue;
      const txn = fresh!.transactions.find((t) => t.id === a.transactionId);
      if (txn && !txn.announced) {
        await deps.publish(txnRecordedEvent(userId, txn));
        await deps.store.markTransactionAnnounced(userId, txn.id);
      }
      await deps.publish({
        id: `anomaly-resolved-${a.id}`,
        type: "anomaly.resolved",
        occurredAt: now.toISOString(),
        userId,
        schemaVersion: 1,
        payload: { anomalyId: a.id, resolution: resolutionOf(a) },
      } as EventEnvelope);
      await deps.store.markAnomalyResolvedAnnounced(userId, a.id);
    }
    return { booked };
  }
  return { run };
}

/**
 * Handles `receipt.unknown` and the answer to its question (`notify.reply_received`).
 *
 * Opening stores one anomaly per receipt, then publishes `anomaly.opened` (inbox only, carrying
 * the question for reference) and `ask.budget_category` (the only chat question), both with
 * deterministic ids. Nothing is booked before the answer. The answer is accepted only from the
 * `budget` source, only for a known open question and only when the value is one of the offered
 * categories; it books the transaction and resolves the anomaly atomically, once. A failed
 * publish is retried by the next delivery of the same event.
 */
export function createUnknownSpendHandlers(deps: UnknownSpendDeps) {
  const offered = (record: SampleBudgetRecord) =>
    record.categories.filter((c) => c.kind === "variable");

  const announceOpened = async (userId: string, record: SampleBudgetRecord, a: AnomalyRecord) => {
    const question = {
      questionId: a.questionId,
      kind: ASK_KIND,
      subjectRef: `anomaly:${a.id}`,
      // Category names are user data (already localized at creation), used as labels.
      options: offered(record).map((c) => ({ value: c.id, labelKey: c.name })),
      expiresAt: a.expiresAt,
      params: { amountVnd: a.receipt.amountVnd, anomalyId: a.id },
    };
    await deps.publish({
      id: `anomaly-opened-${a.id}`,
      type: "anomaly.opened",
      occurredAt: deps.now().toISOString(),
      userId,
      schemaVersion: 1,
      payload: { anomalyId: a.id, kind: a.kind, subjectRef: `receipt:${a.receiptId}`, question },
    } as EventEnvelope);
    await deps.publish({
      id: `ask-budget-category-${a.id}`,
      type: "ask.budget_category",
      occurredAt: deps.now().toISOString(),
      userId,
      schemaVersion: 1,
      payload: question,
    } as EventEnvelope);
    await deps.store.markAnomalyOpenedAnnounced(userId, a.id);
  };

  const announceResolved = async (userId: string, record: SampleBudgetRecord, a: AnomalyRecord) => {
    const txn = record.transactions.find((t) => t.id === a.transactionId);
    if (txn && !txn.announced) {
      await deps.publish(txnRecordedEvent(userId, txn));
      await deps.store.markTransactionAnnounced(userId, txn.id);
    }
    await deps.publish({
      id: `anomaly-resolved-${a.id}`,
      type: "anomaly.resolved",
      occurredAt: deps.now().toISOString(),
      userId,
      schemaVersion: 1,
      payload: { anomalyId: a.id, resolution: resolutionOf(a) },
    } as EventEnvelope);
    await deps.store.markAnomalyResolvedAnnounced(userId, a.id);
  };

  async function onReceiptUnknown(event: EventEnvelope): Promise<void> {
    if (event.type !== "receipt.unknown") return;
    const { payload } = event as EventEnvelope<"receipt.unknown">;
    const record = await deps.store.find(event.userId);
    if (!record || record.cycle.state !== "running") return;

    let anomaly = record.anomalies.find((a) => a.receiptId === payload.receiptId);
    if (!anomaly) {
      const receipt = await deps.readReceipt(event.userId, payload.receiptId);
      if (!receipt || receipt.direction !== "out" || receipt.amountVnd <= 0) return;
      const settings = (await deps.readSettings?.(event.userId)) ?? {};
      const raw = settings["budget.unknown_deadline_hours"];
      const hours =
        Number.isSafeInteger(raw) && (raw as number) > 0
          ? (raw as number)
          : SETTINGS["budget.unknown_deadline_hours"].default;
      const at = deps.now();
      const id = deps.newId();
      const opened = await deps.store.openAnomaly(
        event.userId,
        {
          id,
          kind: "unknown_receipt",
          receiptId: payload.receiptId,
          cycleId: record.cycle.id,
          questionId: `q-${id}`,
          expiresAt: new Date(at.getTime() + hours * HOUR_MS).toISOString(),
          receipt,
          state: "open",
          resolvedCategoryId: null,
          transactionId: null,
          openedAnnounced: false,
          resolvedAnnounced: false,
        },
        at,
      );
      if (opened === "not_running") return;
      anomaly = opened.anomaly;
    }
    // Also for a duplicate: a first delivery whose publish failed leaves events owed.
    if (!anomaly.openedAnnounced) await announceOpened(event.userId, record, anomaly);
  }

  async function onReplyReceived(event: EventEnvelope): Promise<void> {
    if (event.type !== "notify.reply_received") return;
    const { payload } = event as EventEnvelope<"notify.reply_received">;
    if (payload.sourceService !== BUDGET_SOURCE || payload.kind !== ASK_KIND) return;
    const record = await deps.store.find(event.userId);
    const anomaly = record?.anomalies.find((a) => a.questionId === payload.questionId);
    if (!record || !anomaly) return;

    if (anomaly.state === "open") {
      const category = offered(record).find((c) => c.id === payload.value);
      if (!category) return;
      const txn = bookAnomalyTransaction(record, anomaly, category, deps.newId());
      const result = await deps.store.resolveAnomaly(
        event.userId,
        anomaly.id,
        category.id,
        txn,
        deps.now(),
      );
      if (result !== "resolved" && result !== "already_resolved") return;
    }
    // Also when already resolved: a first reply whose publish failed leaves events owed.
    const fresh = await deps.store.find(event.userId);
    const stored = fresh?.anomalies.find((a) => a.id === anomaly.id);
    if (fresh && stored && stored.state === "resolved" && !stored.resolvedAnnounced) {
      await announceResolved(event.userId, fresh, stored);
    }
  }

  return { onReceiptUnknown, onReplyReceived };
}
