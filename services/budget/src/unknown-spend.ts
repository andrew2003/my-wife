import { SETTINGS, type EventEnvelope, type SettingKey } from "@my-wife/contracts";
import type { SampleBudgetRecord, SampleBudgetStore } from "./onboarding";
import type { TransactionRecord } from "./transactions";

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
    }
    await deps.publish({
      id: `anomaly-resolved-${a.id}`,
      type: "anomaly.resolved",
      occurredAt: deps.now().toISOString(),
      userId,
      schemaVersion: 1,
      payload: { anomalyId: a.id, resolution: `category:${a.resolvedCategoryId}` },
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
      const receipt = anomaly.receipt;
      const hint = receipt.bankAccountHint.trim().toUpperCase();
      const account = record.accounts.find((a) => a.code.toUpperCase() === hint);
      const txn: TransactionRecord = {
        id: deps.newId(),
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
