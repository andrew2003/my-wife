import {
  SETTINGS,
  type BankAccount,
  type BudgetCategory,
  type BudgetCycle,
  type EventEnvelope,
  type Locale,
  type PlannedItem,
  type SurplusAllocation,
  type SettingKey,
} from "@my-wife/contracts";
import { t } from "./i18n";
import { RESERVED_SHORT_CODES } from "./transfer-codes";
import { buildSampleBudget, type SampleCategoryTemplate } from "./sample-budget";
import type { TransactionRecord } from "./transactions";
import type { AnomalyRecord } from "./unknown-spend";
import type { DebtRecord } from "./debts";
import type { LimitAdjustment, OverspendRecord, PenaltyDebt, WeekCloseOutcome } from "./overspend";
import type { ExceptionClaim } from "./exceptions";
import type { CycleCloseRecord } from "./surplus";

/**
 * Default total of the sample budget when the user gave no answer (decisions.md, MW-013).
 * A default only: the real total comes from the user's setup answer when it exists.
 */
export const DEFAULT_SAMPLE_TOTAL_VND = 10_000_000;

export interface AuditRecord {
  at: string;
  userId: string;
  action:
    | "sample_budget_generated"
    | "account_code_changed"
    | "account_email_confirmed"
    | "cycle_approved"
    | "account_funded"
    | "cycle_opened"
    | "transaction_recorded"
    | "income_recorded"
    | "category_created"
    | "week_closed"
    | "exception_claimed"
    | "exception_used"
    | "weekly_plan_published"
    | "anomaly_opened"
    | "anomaly_resolved"
    | "debt_opened"
    | "debt_written_off"
    | "cycle_closed"
    | "last_week_excess_settled";
  detail: Record<string, string | number>;
}

export interface SampleBudgetRecord {
  userId: string;
  cycle: BudgetCycle;
  accounts: BankAccount[];
  /** `key` is the stable sample key (for example `future_purchases`); user-created categories have none. */
  categories: (BudgetCategory & { key?: string })[];
  audit: AuditRecord[];
  /** False until `cycle.draft_created` was published, so a failed publish is retried. */
  announced: boolean;
  /** `contract.signed` events received for the user (rules owns the contract itself). */
  signedContracts: { contractId: string; cycleId: string }[];
  /** False until `cycle.funds_requested` was published, so a failed publish is retried. */
  fundsAnnounced: boolean;
  /** Verified incoming receipts that count as funding of an account (MW-021). */
  fundings: FundingRecord[];
  /** False until `cycle.opened` was published, so a failed publish is retried. */
  openedAnnounced: boolean;
  /** Transactions booked from verified receipts (MW-023); append-only. */
  transactions: TransactionRecord[];
  /** Income pool: refund excess and other unallocated income (spec 10 section 6). */
  incomePool: IncomePoolEntry[];
  /** Receipt legs of own accounts waiting for their pair (internal transfers, spec 10 section 5). */
  pendingLegs: PendingLeg[];
  /** Weeks whose close was processed (MW-026): one entry per (cycle, week index). */
  closedWeeks: { cycleId: string; weekIndex: number }[];
  /** Overspends found at week close; `announced` flips after `overspend.detected` was published. */
  overspends: OverspendRecord[];
  /** Deductions from a later week's limit, caused by an overspend. */
  limitAdjustments: LimitAdjustment[];
  /** Overspend left from the last week of a cycle, settled later as penalty debt. */
  penaltyDebts: PenaltyDebt[];
  /** Exceptions claimed by the user; funded from the contingency fund at week close (MW-064). */
  exceptionClaims: ExceptionClaim[];
  /** Unknown spend waiting for a category, or resolved by the user's answer (MW-025). */
  anomalies: AnomalyRecord[];
  /** Debt ledger: receivables and payables (spec 10 section 6, MW-061). */
  debts: DebtRecord[];
  /** Planned items of the weekly plan with their issued transfer codes (#304). */
  plannedItems: PlannedItem[];
  /** Week indexes whose planned items were published (#307); a week is published once. */
  publishedPlanWeeks: number[];
  /** The surplus split of each closed cycle, with the flags of its two events (MW-065). */
  cycleCloses: CycleCloseRecord[];
  /**
   * The cycle before the current one, kept while the current one is `awaiting_funds` so spending
   * in the gap can still be booked to it (spec 10 section 3). Its categories are a snapshot of
   * their ids and short codes. Absent when there is no earlier cycle.
   */
  previousCycle?: PreviousCycleRef;
}

export interface PreviousCycleRef {
  id: string;
  state: "closing" | "closed";
  categories: { id: string; shortCode: string }[];
}

export interface IncomePoolEntry {
  id: string;
  amountVnd: number;
  payer: string;
  receivedAt: string;
  /** The transaction that produced the entry (a refund excess). */
  sourceTransactionId: string;
  allocatedCycleId: string | null;
  /** False until `income.recorded` was published, so a failed publish is retried. */
  announced: boolean;
}

export interface PendingLeg {
  receiptId: string;
  bankTransactionRef: string;
  bankAccountId: string;
  direction: "in" | "out";
  amountVnd: number;
  occurredAt: string;
  memo: string;
}

export interface FundingRecord {
  bankAccountId: string;
  bankTransactionRef: string;
  receiptId: string;
  amountVnd: number;
}

/** Persistence port. A Postgres store must enforce one sample draft per user by unique key. */
export interface SampleBudgetStore {
  find(userId: string): Promise<SampleBudgetRecord | undefined>;
  /** Returns false when a draft for the user already exists (nothing is written then). */
  insertIfAbsent(record: SampleBudgetRecord): Promise<boolean>;
  /**
   * Atomically claims the owed `cycle.draft_created` of the user's draft. Returns undefined
   * when none is owed (already announced) or another delivery holds the claim.
   */
  claimAnnouncement(userId: string): Promise<SampleBudgetRecord | undefined>;
  /** Releases the claim after a failed publish so the next delivery retries. */
  releaseAnnouncementClaim(userId: string): Promise<void>;
  markAnnounced(userId: string): Promise<void>;
  /** Changes an account code (normalized upper case) with an audit record. */
  setAccountCode(
    userId: string,
    accountId: string,
    code: string,
    at: Date,
  ): Promise<"ok" | "invalid" | "duplicate" | "not_found">;
  /**
   * Sets `emailNotificationsConfirmed` once, with an audit record. Returns true only when it
   * changed, so a repeat is a no-op.
   */
  confirmAccountEmail(
    userId: string,
    accountId: string,
    at: Date,
    receiptId: string,
  ): Promise<boolean>;
  /** Remembers a `contract.signed` event; a repeat is a no-op. */
  recordSignedContract(userId: string, contractId: string, cycleId: string): Promise<void>;
  /**
   * Atomically moves the user's cycle from `draft` to `awaiting_funds`, stores the commitment
   * and writes an audit record. Anything but `draft` changes nothing.
   */
  approveDraft(
    userId: string,
    cycleId: string,
    commitmentId: string,
    at: Date,
  ): Promise<"ok" | "not_draft" | "not_found">;
  markFundsAnnounced(userId: string): Promise<void>;
  /**
   * Records a funding receipt with an audit record. A `bankTransactionRef` already recorded for
   * the user is `duplicate` and changes nothing; a cycle not `awaiting_funds` is `not_awaiting`.
   */
  recordFunding(
    userId: string,
    cycleId: string,
    funding: FundingRecord,
    at: Date,
  ): Promise<"recorded" | "duplicate" | "not_awaiting">;
  /**
   * Atomically moves `awaiting_funds` to `running` (sets `openedAt`, audit record) when every
   * account in `required` has a funding of at least its `requiredVnd` (zero needs none).
   */
  openIfFunded(
    userId: string,
    cycleId: string,
    required: readonly { bankAccountId: string; requiredVnd: number }[],
    at: Date,
  ): Promise<"opened" | "not_ready" | "not_awaiting">;
  markOpenedAnnounced(userId: string): Promise<void>;
  /**
   * Books a transaction with an audit record. A `bankTransactionRef` already booked for the user
   * is `duplicate` and changes nothing; a cycle that is not `running` is `not_running`.
   */
  recordTransaction(
    userId: string,
    cycleId: string,
    txn: TransactionRecord,
    at: Date,
    income?: IncomePoolEntry,
    /** A system category created together with the transaction (the bank fees category). */
    newCategory?: BudgetCategory,
  ): Promise<"recorded" | "duplicate" | "not_running">;
  /**
   * Books a transaction to the previous cycle while the current cycle is `awaiting_funds`
   * (spec 10 section 3). Append-only: no existing record of the previous cycle is edited. A
   * `bankTransactionRef` already recorded is `duplicate`; no previous cycle or a current cycle
   * that is not `awaiting_funds` is `not_awaiting`.
   */
  recordAwaitingFundsTransaction(
    userId: string,
    txn: TransactionRecord,
    at: Date,
  ): Promise<"recorded" | "duplicate" | "not_awaiting">;
  markTransactionAnnounced(userId: string, transactionId: string): Promise<void>;
  markIncomeAnnounced(userId: string, entryId: string): Promise<void>;
  /** Keeps a receipt leg until its pair arrives; the same `bankTransactionRef` is kept once. */
  holdLeg(userId: string, leg: PendingLeg): Promise<void>;
  /**
   * Atomically books the legs of an internal transfer (each with an audit record) and drops the
   * pending legs they consume. Legs already booked by `bankTransactionRef` are skipped.
   */
  recordInternalTransfer(
    userId: string,
    cycleId: string,
    txns: TransactionRecord[],
    at: Date,
  ): Promise<"recorded" | "not_running">;
  /**
   * Stores the planned items of one week with an audit record. A week already published is
   * `already_published` and changes nothing; a cycle that is not `running` is `not_running`.
   */
  publishWeeklyPlan(
    userId: string,
    cycleId: string,
    weekIndex: number,
    items: PlannedItem[],
    at: Date,
  ): Promise<"published" | "already_published" | "not_running">;
  /**
   * Stores an anomaly with an audit record. One anomaly per `receiptId`: a repeat returns the
   * stored one as `duplicate` and writes nothing; a cycle that is not `running` is `not_running`.
   */
  openAnomaly(
    userId: string,
    anomaly: AnomalyRecord,
    at: Date,
  ): Promise<{ result: "opened" | "duplicate"; anomaly: AnomalyRecord } | "not_running">;
  markAnomalyOpenedAnnounced(userId: string, anomalyId: string): Promise<void>;
  /**
   * Atomically resolves an open anomaly: books `txn` (already carrying the chosen category) and
   * writes audit records. A resolved anomaly is `already_resolved` and changes nothing.
   */
  resolveAnomaly(
    userId: string,
    anomalyId: string,
    categoryId: string,
    txn: TransactionRecord,
    at: Date,
    by?: "answer" | "deadline",
  ): Promise<"resolved" | "already_resolved" | "not_found" | "not_running">;
  markAnomalyResolvedAnnounced(userId: string, anomalyId: string): Promise<void>;
  /**
   * Atomically records the close of a week with its overspends, deductions, debts and an audit
   * record. A (cycle, week) already closed returns `duplicate` and writes nothing.
   */
  closeWeek(
    userId: string,
    cycleId: string,
    weekIndex: number,
    outcome: WeekCloseOutcome,
    at: Date,
  ): Promise<"closed" | "duplicate" | "not_running">;
  /** Claims the overspends of the week still owing `overspend.detected`; a claim is held once. */
  claimOverspends(userId: string, cycleId: string, weekIndex: number): Promise<OverspendRecord[]>;
  /** Releases claims after a failed publish so the next delivery retries. */
  releaseOverspendClaims(userId: string, cycleId: string, weekIndex: number): Promise<void>;
  markOverspendAnnounced(userId: string, overspendId: string): Promise<void>;
  /**
   * Atomically records an exception claim with an audit record, unless the week closed, the
   * category already has a claim that week, or `quota` non-released claims exist in the cycle.
   */
  claimException(
    userId: string,
    claim: ExceptionClaim,
    quota: number,
    at: Date,
  ): Promise<
    | { result: "claimed"; remaining: number }
    | { result: "not_running" | "week_closed" | "duplicate" | "limit_reached" }
  >;
  /** Claims the applied exceptions of the week still owing `exception.used`; held once. */
  claimExceptionAnnouncements(
    userId: string,
    cycleId: string,
    weekIndex: number,
  ): Promise<ExceptionClaim[]>;
  releaseExceptionClaims(userId: string, cycleId: string, weekIndex: number): Promise<void>;
  markExceptionAnnounced(userId: string, claimId: string): Promise<void>;
  /** Stores a new debt with an audit record. */
  openDebt(userId: string, debt: DebtRecord, at: Date): Promise<"opened" | "not_found">;
  markDebtOpenedAnnounced(userId: string, debtId: string): Promise<void>;
  /** Atomically stores several debts (a shared expense) with one audit record each. */
  openDebts(userId: string, debts: DebtRecord[], at: Date): Promise<"opened" | "not_found">;
  /** Stores an income pool entry that has no transaction yet, with an audit record. */
  recordIncome(userId: string, entry: IncomePoolEntry, at: Date): Promise<"recorded" | "not_found">;
  /**
   * Atomically writes off the open part of a receivable: books `txn` (an expense of its funding
   * category), marks the debt `written_off` and writes an audit record. A debt that is not an
   * open receivable, or whose cycle is not running, changes nothing.
   */
  writeOffDebt(
    userId: string,
    debtId: string,
    txn: TransactionRecord,
    at: Date,
  ): Promise<"written_off" | "not_open" | "not_found" | "not_running">;
  markDebtWrittenOffAnnounced(userId: string, debtId: string): Promise<void>;
  /**
   * Atomically closes a `closing` cycle with its surplus allocation and an audit record. A cycle
   * that is already closed returns `duplicate` and writes nothing.
   */
  closeCycle(
    userId: string,
    cycleId: string,
    allocation: SurplusAllocation,
    at: Date,
    /** Last-week excess of the cycle: deductions for the next cycle and what stays as debt. */
    settlement?: { adjustments: LimitAdjustment[]; remainingDebts: PenaltyDebt[] },
  ): Promise<"closed" | "duplicate" | "not_closing">;
  markCycleCloseAnnounced(
    userId: string,
    cycleId: string,
    event: "surplus" | "cycle",
  ): Promise<void>;
}

export class MemorySampleBudgetStore implements SampleBudgetStore {
  private readonly records = new Map<string, SampleBudgetRecord>();

  async find(userId: string) {
    return this.records.get(userId);
  }

  async insertIfAbsent(record: SampleBudgetRecord) {
    if (this.records.has(record.userId)) return false;
    this.records.set(record.userId, record);
    return true;
  }

  private readonly claims = new Set<string>();

  // Synchronous check-and-set: no await between the test and the write.
  async claimAnnouncement(userId: string) {
    const r = this.records.get(userId);
    if (!r || r.announced || this.claims.has(userId)) return undefined;
    this.claims.add(userId);
    return r;
  }

  async releaseAnnouncementClaim(userId: string) {
    this.claims.delete(userId);
  }

  async markAnnounced(userId: string) {
    const r = this.records.get(userId);
    if (r) r.announced = true;
    this.claims.delete(userId);
  }

  async setAccountCode(userId: string, accountId: string, code: string, at: Date) {
    const r = this.records.get(userId);
    const account = r?.accounts.find((a) => a.id === accountId);
    if (!r || !account) return "not_found" as const;
    const next = code.trim().toUpperCase();
    if (!/^[A-Z0-9]{1,12}$/.test(next) || RESERVED_SHORT_CODES.includes(next)) {
      return "invalid" as const;
    }
    if (r.accounts.some((a) => a.id !== accountId && a.code === next)) return "duplicate" as const;
    if (account.code === next) return "ok" as const;
    r.audit.push({
      at: at.toISOString(),
      userId,
      action: "account_code_changed",
      detail: { accountId, from: account.code, to: next },
    });
    account.code = next;
    return "ok" as const;
  }

  async confirmAccountEmail(userId: string, accountId: string, at: Date, receiptId: string) {
    const r = this.records.get(userId);
    const account = r?.accounts.find((a) => a.id === accountId);
    if (!r || !account || account.emailNotificationsConfirmed) return false;
    account.emailNotificationsConfirmed = true;
    r.audit.push({
      at: at.toISOString(),
      userId,
      action: "account_email_confirmed",
      detail: { accountId, receiptId },
    });
    return true;
  }

  async recordSignedContract(userId: string, contractId: string, cycleId: string) {
    const r = this.records.get(userId);
    if (!r || r.signedContracts.some((c) => c.contractId === contractId)) return;
    r.signedContracts.push({ contractId, cycleId });
  }

  async approveDraft(userId: string, cycleId: string, commitmentId: string, at: Date) {
    const r = this.records.get(userId);
    if (!r || r.cycle.id !== cycleId) return "not_found" as const;
    if (r.cycle.state !== "draft") return "not_draft" as const;
    r.cycle.state = "awaiting_funds";
    r.cycle.commitmentId = commitmentId;
    r.audit.push({
      at: at.toISOString(),
      userId,
      action: "cycle_approved",
      detail: { cycleId, commitmentId },
    });
    return "ok" as const;
  }

  async markFundsAnnounced(userId: string) {
    const r = this.records.get(userId);
    if (r) r.fundsAnnounced = true;
  }

  async recordFunding(userId: string, cycleId: string, funding: FundingRecord, at: Date) {
    const r = this.records.get(userId);
    if (!r || r.cycle.id !== cycleId || r.cycle.state !== "awaiting_funds") {
      return "not_awaiting" as const;
    }
    if (r.fundings.some((f) => f.bankTransactionRef === funding.bankTransactionRef)) {
      return "duplicate" as const;
    }
    r.fundings.push({ ...funding });
    r.audit.push({
      at: at.toISOString(),
      userId,
      action: "account_funded",
      detail: {
        cycleId,
        accountId: funding.bankAccountId,
        receiptId: funding.receiptId,
        bankTransactionRef: funding.bankTransactionRef,
        amountVnd: funding.amountVnd,
      },
    });
    return "recorded" as const;
  }

  async openIfFunded(
    userId: string,
    cycleId: string,
    required: readonly { bankAccountId: string; requiredVnd: number }[],
    at: Date,
  ) {
    const r = this.records.get(userId);
    if (!r || r.cycle.id !== cycleId || r.cycle.state !== "awaiting_funds") {
      return "not_awaiting" as const;
    }
    const funded = required.every(
      (q) =>
        q.requiredVnd === 0 ||
        r.fundings.some((f) => f.bankAccountId === q.bankAccountId && f.amountVnd >= q.requiredVnd),
    );
    if (!funded) return "not_ready" as const;
    r.cycle.state = "running";
    r.cycle.openedAt = at.toISOString();
    r.audit.push({ at: at.toISOString(), userId, action: "cycle_opened", detail: { cycleId } });
    return "opened" as const;
  }

  async markOpenedAnnounced(userId: string) {
    const r = this.records.get(userId);
    if (r) r.openedAnnounced = true;
  }

  async recordTransaction(
    userId: string,
    cycleId: string,
    txn: TransactionRecord,
    at: Date,
    income?: IncomePoolEntry,
    newCategory?: BudgetCategory,
  ) {
    const r = this.records.get(userId);
    if (!r || r.cycle.id !== cycleId || r.cycle.state !== "running") {
      return "not_running" as const;
    }
    if (r.transactions.some((t) => t.bankTransactionRef === txn.bankTransactionRef)) {
      return "duplicate" as const;
    }
    if (newCategory && !r.categories.some((c) => c.shortCode === newCategory.shortCode)) {
      r.categories.push({ ...newCategory });
      r.audit.push({
        at: at.toISOString(),
        userId,
        action: "category_created",
        detail: { cycleId, categoryId: newCategory.id, shortCode: newCategory.shortCode },
      });
    }
    r.transactions.push({ ...txn });
    const item = txn.plannedItemId
      ? r.plannedItems.find((i) => i.id === txn.plannedItemId)
      : undefined;
    if (item) item.status = txn.reconciliationResult === "matched" ? "matched" : "mismatch";
    r.audit.push({
      at: at.toISOString(),
      userId,
      action: "transaction_recorded",
      detail: {
        cycleId,
        transactionId: txn.id,
        receiptId: txn.receiptId,
        bankTransactionRef: txn.bankTransactionRef,
        categoryId: txn.categoryId ?? "",
        amountVnd: txn.amountVnd,
        reconciliationResult: txn.reconciliationResult,
        ...(txn.plannedItemId ? { plannedItemId: txn.plannedItemId } : {}),
      },
    });
    if (income) {
      r.incomePool.push({ ...income });
      r.audit.push({
        at: at.toISOString(),
        userId,
        action: "income_recorded",
        detail: {
          cycleId,
          entryId: income.id,
          transactionId: txn.id,
          amountVnd: income.amountVnd,
        },
      });
    }
    return "recorded" as const;
  }

  async recordAwaitingFundsTransaction(userId: string, txn: TransactionRecord, at: Date) {
    const r = this.records.get(userId);
    if (!r || !r.previousCycle || r.cycle.state !== "awaiting_funds") {
      return "not_awaiting" as const;
    }
    if (txn.cycleId !== r.previousCycle.id) return "not_awaiting" as const;
    if (r.transactions.some((t) => t.bankTransactionRef === txn.bankTransactionRef)) {
      return "duplicate" as const;
    }
    r.transactions.push({ ...txn });
    r.audit.push({
      at: at.toISOString(),
      userId,
      action: "transaction_recorded",
      detail: {
        cycleId: txn.cycleId,
        transactionId: txn.id,
        receiptId: txn.receiptId,
        bankTransactionRef: txn.bankTransactionRef,
        categoryId: txn.categoryId ?? "",
        amountVnd: txn.amountVnd,
        reconciliationResult: txn.reconciliationResult,
        awaitingFunds: 1,
      },
    });
    return "recorded" as const;
  }

  async markIncomeAnnounced(userId: string, entryId: string) {
    const entry = this.records.get(userId)?.incomePool.find((e) => e.id === entryId);
    if (entry) entry.announced = true;
  }

  async holdLeg(userId: string, leg: PendingLeg) {
    const r = this.records.get(userId);
    if (!r || r.pendingLegs.some((l) => l.bankTransactionRef === leg.bankTransactionRef)) return;
    r.pendingLegs.push({ ...leg });
  }

  async recordInternalTransfer(
    userId: string,
    cycleId: string,
    txns: TransactionRecord[],
    at: Date,
  ) {
    const r = this.records.get(userId);
    if (!r || r.cycle.id !== cycleId || r.cycle.state !== "running") {
      return "not_running" as const;
    }
    for (const txn of txns) {
      if (r.transactions.some((t) => t.bankTransactionRef === txn.bankTransactionRef)) continue;
      r.transactions.push({ ...txn });
      r.audit.push({
        at: at.toISOString(),
        userId,
        action: "transaction_recorded",
        detail: {
          cycleId,
          transactionId: txn.id,
          receiptId: txn.receiptId,
          bankTransactionRef: txn.bankTransactionRef,
          amountVnd: txn.amountVnd,
          reconciliationResult: txn.reconciliationResult,
        },
      });
    }
    const booked = new Set(txns.map((t) => t.bankTransactionRef));
    r.pendingLegs = r.pendingLegs.filter((l) => !booked.has(l.bankTransactionRef));
    return "recorded" as const;
  }

  async publishWeeklyPlan(
    userId: string,
    cycleId: string,
    weekIndex: number,
    items: PlannedItem[],
    at: Date,
  ) {
    const r = this.records.get(userId);
    if (!r || r.cycle.id !== cycleId || r.cycle.state !== "running") {
      return "not_running" as const;
    }
    if (r.publishedPlanWeeks.includes(weekIndex)) return "already_published" as const;
    r.publishedPlanWeeks.push(weekIndex);
    r.plannedItems.push(...items.map((i) => ({ ...i })));
    r.audit.push({
      at: at.toISOString(),
      userId,
      action: "weekly_plan_published",
      detail: { cycleId, weekIndex, itemCount: items.length },
    });
    return "published" as const;
  }

  async markTransactionAnnounced(userId: string, transactionId: string) {
    const txn = this.records.get(userId)?.transactions.find((t) => t.id === transactionId);
    if (txn) txn.announced = true;
  }

  async openAnomaly(userId: string, anomaly: AnomalyRecord, at: Date) {
    const r = this.records.get(userId);
    const existing = r?.anomalies.find((a) => a.receiptId === anomaly.receiptId);
    if (existing) return { result: "duplicate" as const, anomaly: { ...existing } };
    if (!r || r.cycle.id !== anomaly.cycleId || r.cycle.state !== "running") {
      return "not_running" as const;
    }
    r.anomalies.push({ ...anomaly });
    r.audit.push({
      at: at.toISOString(),
      userId,
      action: "anomaly_opened",
      detail: {
        anomalyId: anomaly.id,
        receiptId: anomaly.receiptId,
        kind: anomaly.kind,
        amountVnd: anomaly.receipt.amountVnd,
      },
    });
    return { result: "opened" as const, anomaly: { ...anomaly } };
  }

  async markAnomalyOpenedAnnounced(userId: string, anomalyId: string) {
    const a = this.records.get(userId)?.anomalies.find((x) => x.id === anomalyId);
    if (a) a.openedAnnounced = true;
  }

  // Synchronous check-and-set: no await between the state test and the writes.
  async resolveAnomaly(
    userId: string,
    anomalyId: string,
    categoryId: string,
    txn: TransactionRecord,
    at: Date,
    by: "answer" | "deadline" = "answer",
  ) {
    const r = this.records.get(userId);
    const a = r?.anomalies.find((x) => x.id === anomalyId);
    if (!r || !a) return "not_found" as const;
    if (a.state === "resolved") return "already_resolved" as const;
    if (r.cycle.id !== a.cycleId || r.cycle.state !== "running") return "not_running" as const;
    if (r.transactions.some((t) => t.bankTransactionRef === txn.bankTransactionRef)) {
      return "already_resolved" as const;
    }
    a.state = "resolved";
    if (by === "deadline") a.resolvedByDeadline = true;
    a.resolvedCategoryId = categoryId;
    a.transactionId = txn.id;
    r.transactions.push({ ...txn });
    r.audit.push(
      {
        at: at.toISOString(),
        userId,
        action: "transaction_recorded",
        detail: {
          cycleId: txn.cycleId,
          transactionId: txn.id,
          receiptId: txn.receiptId,
          bankTransactionRef: txn.bankTransactionRef,
          categoryId,
          amountVnd: txn.amountVnd,
        },
      },
      {
        at: at.toISOString(),
        userId,
        action: "anomaly_resolved",
        detail: { anomalyId, categoryId, transactionId: txn.id, by },
      },
    );
    return "resolved" as const;
  }

  async markAnomalyResolvedAnnounced(userId: string, anomalyId: string) {
    const a = this.records.get(userId)?.anomalies.find((x) => x.id === anomalyId);
    if (a) a.resolvedAnnounced = true;
  }

  private readonly overspendClaims = new Set<string>();

  async closeWeek(
    userId: string,
    cycleId: string,
    weekIndex: number,
    outcome: WeekCloseOutcome,
    at: Date,
  ) {
    const r = this.records.get(userId);
    if (!r || r.cycle.id !== cycleId || r.cycle.state !== "running") {
      return "not_running" as const;
    }
    if (r.closedWeeks.some((w) => w.cycleId === cycleId && w.weekIndex === weekIndex)) {
      return "duplicate" as const;
    }
    r.closedWeeks.push({ cycleId, weekIndex });
    // Claims of the week are settled with the close: funded ones debit the contingency fund.
    for (const c of r.exceptionClaims) {
      if (c.cycleId !== cycleId || c.weekIndex !== weekIndex || c.state !== "claimed") continue;
      const applied = outcome.exceptions.find((e) => e.categoryId === c.categoryId);
      if (applied) {
        c.state = "applied";
        c.fundedVnd = applied.fundedVnd;
        r.audit.push({
          at: at.toISOString(),
          userId,
          action: "exception_used",
          detail: {
            claimId: c.id,
            cycleId,
            weekIndex,
            categoryId: c.categoryId,
            fundedVnd: applied.fundedVnd,
          },
        });
      } else {
        c.state = "released";
      }
    }
    r.overspends.push(...outcome.overspends.map((o) => ({ ...o })));
    r.limitAdjustments.push(...outcome.adjustments.map((a) => ({ ...a })));
    r.penaltyDebts.push(...outcome.debts.map((d) => ({ ...d })));
    r.audit.push({
      at: at.toISOString(),
      userId,
      action: "week_closed",
      detail: {
        cycleId,
        weekIndex,
        overspends: outcome.overspends.length,
        deductedVnd: outcome.adjustments.reduce((sum, a) => sum + a.deductionVnd, 0),
        debtVnd: outcome.debts.reduce((sum, d) => sum + d.amountVnd, 0),
      },
    });
    return "closed" as const;
  }

  // Synchronous check-and-set: no await between the test and the write.
  async claimOverspends(userId: string, cycleId: string, weekIndex: number) {
    const r = this.records.get(userId);
    if (!r) return [];
    const owed = r.overspends.filter(
      (o) =>
        o.cycleId === cycleId &&
        o.weekIndex === weekIndex &&
        !o.announced &&
        !this.overspendClaims.has(o.id),
    );
    for (const o of owed) this.overspendClaims.add(o.id);
    return owed;
  }

  async releaseOverspendClaims(userId: string, cycleId: string, weekIndex: number) {
    const r = this.records.get(userId);
    for (const o of r?.overspends ?? []) {
      if (o.cycleId === cycleId && o.weekIndex === weekIndex) this.overspendClaims.delete(o.id);
    }
  }

  async markOverspendAnnounced(userId: string, overspendId: string) {
    const o = this.records.get(userId)?.overspends.find((x) => x.id === overspendId);
    if (o) o.announced = true;
  }

  private readonly exceptionAnnounceClaims = new Set<string>();

  // Synchronous check-and-set: no await between the tests and the write.
  async claimException(userId: string, claim: ExceptionClaim, quota: number, at: Date) {
    const r = this.records.get(userId);
    if (!r || r.cycle.id !== claim.cycleId || r.cycle.state !== "running") {
      return { result: "not_running" as const };
    }
    if (r.closedWeeks.some((w) => w.cycleId === claim.cycleId && w.weekIndex === claim.weekIndex)) {
      return { result: "week_closed" as const };
    }
    const live = r.exceptionClaims.filter(
      (c) => c.cycleId === claim.cycleId && c.state !== "released",
    );
    if (live.some((c) => c.weekIndex === claim.weekIndex && c.categoryId === claim.categoryId)) {
      return { result: "duplicate" as const };
    }
    if (live.length >= quota) return { result: "limit_reached" as const };
    r.exceptionClaims.push({ ...claim });
    r.audit.push({
      at: at.toISOString(),
      userId,
      action: "exception_claimed",
      detail: {
        claimId: claim.id,
        cycleId: claim.cycleId,
        weekIndex: claim.weekIndex,
        categoryId: claim.categoryId,
      },
    });
    return { result: "claimed" as const, remaining: quota - live.length - 1 };
  }

  async claimExceptionAnnouncements(userId: string, cycleId: string, weekIndex: number) {
    const owed = (this.records.get(userId)?.exceptionClaims ?? []).filter(
      (c) =>
        c.cycleId === cycleId &&
        c.weekIndex === weekIndex &&
        c.state === "applied" &&
        c.fundedVnd > 0 &&
        !c.announced &&
        !this.exceptionAnnounceClaims.has(c.id),
    );
    for (const c of owed) this.exceptionAnnounceClaims.add(c.id);
    return owed.map((c) => ({ ...c }));
  }

  async releaseExceptionClaims(userId: string, cycleId: string, weekIndex: number) {
    for (const c of this.records.get(userId)?.exceptionClaims ?? []) {
      if (c.cycleId === cycleId && c.weekIndex === weekIndex) {
        this.exceptionAnnounceClaims.delete(c.id);
      }
    }
  }

  async markExceptionAnnounced(userId: string, claimId: string) {
    const c = this.records.get(userId)?.exceptionClaims.find((x) => x.id === claimId);
    if (c) c.announced = true;
  }

  async openDebt(userId: string, debt: DebtRecord, at: Date) {
    const r = this.records.get(userId);
    if (!r) return "not_found" as const;
    r.debts.push({ ...debt });
    r.audit.push({
      at: at.toISOString(),
      userId,
      action: "debt_opened",
      detail: {
        debtId: debt.id,
        kind: debt.kind,
        amountVnd: debt.amountVnd,
        dueAt: debt.dueAt ?? "",
      },
    });
    return "opened" as const;
  }

  async openDebts(userId: string, debts: DebtRecord[], at: Date) {
    if (!this.records.has(userId)) return "not_found" as const;
    for (const debt of debts) await this.openDebt(userId, debt, at);
    return "opened" as const;
  }

  async recordIncome(userId: string, entry: IncomePoolEntry, at: Date) {
    const r = this.records.get(userId);
    if (!r) return "not_found" as const;
    r.incomePool.push({ ...entry });
    r.audit.push({
      at: at.toISOString(),
      userId,
      action: "income_recorded",
      detail: { cycleId: r.cycle.id, entryId: entry.id, amountVnd: entry.amountVnd },
    });
    return "recorded" as const;
  }

  async markDebtOpenedAnnounced(userId: string, debtId: string) {
    const d = this.records.get(userId)?.debts.find((x) => x.id === debtId);
    if (d) d.openedAnnounced = true;
  }

  async writeOffDebt(userId: string, debtId: string, txn: TransactionRecord, at: Date) {
    const r = this.records.get(userId);
    const debt = r?.debts.find((d) => d.id === debtId);
    if (!r || !debt) return "not_found" as const;
    if (r.cycle.id !== txn.cycleId || r.cycle.state !== "running") return "not_running" as const;
    if (
      debt.kind !== "receivable" ||
      (debt.state !== "open" && debt.state !== "partially_settled")
    ) {
      return "not_open" as const;
    }
    r.transactions.push({ ...txn });
    debt.state = "written_off";
    debt.writeOffTransactionId = txn.id;
    debt.writtenOffAnnounced = false;
    r.audit.push({
      at: at.toISOString(),
      userId,
      action: "debt_written_off",
      detail: {
        debtId,
        transactionId: txn.id,
        amountVnd: txn.amountVnd,
        categoryId: txn.categoryId ?? "",
      },
    });
    return "written_off" as const;
  }

  async markDebtWrittenOffAnnounced(userId: string, debtId: string) {
    const d = this.records.get(userId)?.debts.find((x) => x.id === debtId);
    if (d) d.writtenOffAnnounced = true;
  }

  async closeCycle(
    userId: string,
    cycleId: string,
    allocation: SurplusAllocation,
    at: Date,
    settlement?: { adjustments: LimitAdjustment[]; remainingDebts: PenaltyDebt[] },
  ) {
    const r = this.records.get(userId);
    if (!r || r.cycle.id !== cycleId) return "not_closing" as const;
    if (r.cycleCloses.some((c) => c.cycleId === cycleId)) return "duplicate" as const;
    if (r.cycle.state !== "closing") return "not_closing" as const;
    r.cycle.state = "closed";
    r.cycle.closedAt = at.toISOString();
    if (settlement) {
      const owed = r.penaltyDebts.filter((d) => d.cycleId === cycleId);
      if (owed.length > 0) {
        r.penaltyDebts = [
          ...r.penaltyDebts.filter((d) => d.cycleId !== cycleId),
          ...settlement.remainingDebts.map((d) => ({ ...d })),
        ];
        r.limitAdjustments.push(...settlement.adjustments.map((a) => ({ ...a })));
        r.audit.push({
          at: at.toISOString(),
          userId,
          action: "last_week_excess_settled",
          detail: {
            cycleId,
            deductedVnd: settlement.adjustments.reduce((sum, a) => sum + a.deductionVnd, 0),
            debtVnd: settlement.remainingDebts.reduce((sum, d) => sum + d.amountVnd, 0),
          },
        });
      }
    }
    r.cycleCloses.push({
      cycleId,
      allocation: { ...allocation },
      closedAt: at.toISOString(),
      surplusAnnounced: false,
      cycleAnnounced: false,
    });
    r.audit.push({
      at: at.toISOString(),
      userId,
      action: "cycle_closed",
      detail: {
        cycleId,
        totalVnd: allocation.totalVnd,
        savingsVnd: allocation.savingsVnd,
        futurePurchasesVnd: allocation.futurePurchasesVnd,
        remainderVnd: allocation.remainderVnd,
        remainderTarget: allocation.remainderTarget,
      },
    });
    return "closed" as const;
  }

  async markCycleCloseAnnounced(userId: string, cycleId: string, event: "surplus" | "cycle") {
    const c = this.records.get(userId)?.cycleCloses.find((x) => x.cycleId === cycleId);
    if (!c) return;
    if (event === "surplus") c.surplusAnnounced = true;
    else c.cycleAnnounced = true;
  }

  /** Sync helpers for tests. */
  get(userId: string) {
    return this.records.get(userId);
  }

  count() {
    return this.records.size;
  }
}

export interface OnboardingDeps {
  store: SampleBudgetStore;
  locale: Locale;
  now: () => Date;
  newId: () => string;
  publish: (event: EventEnvelope) => void | Promise<void>;
  /** Reads the user's settings (identity); missing or invalid keys fall back to registry defaults. */
  readSettings?: (userId: string) => Promise<Partial<Record<SettingKey, unknown>>>;
  /** The user's total budget answer per cycle, when one exists. */
  totalVnd?: (userId: string) => number | undefined;
  /** Override of the sample ratios. */
  template?: readonly SampleCategoryTemplate[];
}

const ACCOUNT_CODES = { spending: "MAIN", savings: "SAV", penalty_savings: "PEN" } as const;

/**
 * Handles `onboarding.step_completed`. On step `qa_templates` (skipped or not) it creates the
 * sample budget draft once per user. Redelivery is safe; a failed publish is retried.
 */
export function createOnboardingHandler(deps: OnboardingDeps) {
  const pick = <T>(
    values: Partial<Record<SettingKey, unknown>>,
    key: SettingKey,
    ok: (v: unknown) => v is T,
  ): T => {
    const v = values[key];
    return ok(v) ? v : (SETTINGS[key].default as T);
  };
  const isPosInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
  const isZone = (v: unknown): v is string => {
    if (typeof v !== "string" || !v) return false;
    try {
      new Intl.DateTimeFormat("en-CA", { timeZone: v });
      return true;
    } catch {
      return false;
    }
  };

  return async function onOnboardingStepCompleted(event: EventEnvelope): Promise<void> {
    if (event.type !== "onboarding.step_completed") return;
    const { step } = (event as EventEnvelope<"onboarding.step_completed">).payload;
    if (step !== "qa_templates") return;
    const userId = event.userId;

    let record = await deps.store.find(userId);
    if (!record) {
      record = buildRecord(userId, (await deps.readSettings?.(userId)) ?? {});
      const inserted = await deps.store.insertIfAbsent(record);
      if (!inserted) record = await deps.store.find(userId);
    }
    if (!record) return;
    const owed = await deps.store.claimAnnouncement(userId);
    if (!owed) return;

    try {
      await deps.publish({
        id: deps.newId(),
        type: "cycle.draft_created",
        occurredAt: deps.now().toISOString(),
        userId,
        schemaVersion: event.schemaVersion,
        payload: { cycleId: owed.cycle.id, sequence: owed.cycle.sequence },
      } as EventEnvelope);
    } catch (err) {
      await deps.store.releaseAnnouncementClaim(userId);
      throw err;
    }
    await deps.store.markAnnounced(userId);
  };

  function buildRecord(
    userId: string,
    values: Partial<Record<SettingKey, unknown>>,
  ): SampleBudgetRecord {
    const total = deps.totalVnd?.(userId) ?? DEFAULT_SAMPLE_TOTAL_VND;
    const weeks = pick(values, "budget.cycle_weeks", isPosInt);
    const draft = buildSampleBudget({
      totalVnd: total,
      roundingVnd: pick(values, "budget.weekly_limit_rounding_vnd", isPosInt),
      template: deps.template,
    });
    const now = deps.now();
    const accounts: BankAccount[] = (["spending", "savings", "penalty_savings"] as const).map(
      (kind) => ({
        id: deps.newId(),
        name: t(`budget.sample.account.${kind}`, deps.locale),
        code: ACCOUNT_CODES[kind],
        kind,
        emailNotificationsConfirmed: false,
      }),
    );
    const accountOf = (kind: BankAccount["kind"]) => accounts.find((a) => a.kind === kind)!.id;
    const cycle: BudgetCycle = {
      id: deps.newId(),
      sequence: 1,
      weeks,
      firstDay: localDate(now, pick(values, "calendar.time_zone", isZone)),
      state: "draft",
      openedAt: null,
      closedAt: null,
      commitmentId: null,
    };
    return {
      userId,
      cycle,
      accounts,
      categories: draft.categories.map((c) => ({
        id: deps.newId(),
        key: c.key,
        name: t(`budget.sample.category.${c.key}`, deps.locale),
        shortCode: c.shortCode,
        priority: c.priority,
        kind: c.kind,
        countsTowardSurplus: c.countsTowardSurplus,
        bankAccountId: accountOf(c.accountKind),
        cycleLimitVnd: c.cycleLimitVnd,
        wantOrder: c.wantOrder,
      })),
      audit: [
        {
          at: now.toISOString(),
          userId,
          action: "sample_budget_generated",
          detail: { totalVnd: total, sequence: 1 },
        },
      ],
      announced: false,
      signedContracts: [],
      fundsAnnounced: false,
      fundings: [],
      openedAnnounced: false,
      closedWeeks: [],
      overspends: [],
      limitAdjustments: [],
      penaltyDebts: [],
      exceptionClaims: [],
      anomalies: [],
      plannedItems: [],
      publishedPlanWeeks: [],
      cycleCloses: [],
      debts: [],
      transactions: [],
      incomePool: [],
      pendingLegs: [],
    };
  }
}

/** ISO date (YYYY-MM-DD) of `at` in the given IANA time zone. */
export function localDate(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
