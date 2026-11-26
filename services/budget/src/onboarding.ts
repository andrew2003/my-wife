import {
  SETTINGS,
  type BankAccount,
  type BudgetCategory,
  type BudgetCycle,
  type EventEnvelope,
  type Locale,
  type SettingKey,
} from "@my-wife/contracts";
import { t } from "./i18n";
import { RESERVED_SHORT_CODES } from "./transfer-codes";
import { buildSampleBudget, type SampleCategoryTemplate } from "./sample-budget";

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
    | "cycle_opened";
  detail: Record<string, string | number>;
}

export interface SampleBudgetRecord {
  userId: string;
  cycle: BudgetCycle;
  accounts: BankAccount[];
  categories: BudgetCategory[];
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
