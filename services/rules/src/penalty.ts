import { randomUUID } from "node:crypto";
import {
  EVENT_SCHEMA_VERSION,
  SETTINGS,
  type EventEnvelope,
  type EventPayload,
} from "@my-wife/contracts";
import type { ContractStore } from "./contract";
import {
  allocatePenaltySource,
  computeWithdrawalPenalty,
  DEFAULT_WITHDRAWAL_SETTINGS,
  type PenaltyDebtStore,
  type WantLimit,
} from "./penalty-source";
import type { SettlementLine, TrialStore } from "./trial";

const DAY_MS = 86_400_000;

/**
 * Days between issuing a penalty and its due date. The settings registry has no key for
 * it yet (see docs/decisions.md), so it is an injectable service option, not a literal.
 */
export const DEFAULT_PENALTY_DUE_DAYS = 7;

export type NeedOverspendMode = "warn_only" | "penalize";

/** Overspend penalty settings of one user; defaults come from the registry. */
export type PenaltySettings = {
  needMode: NeedOverspendMode;
  overspendPercent: number;
  /** `penalty.want_deduction_order`; empty means the order of the want list. */
  wantDeductionOrder?: readonly string[];
  /** `penalty.withdrawal_extra_percent`. */
  withdrawalExtraPercent?: number;
};

export const DEFAULT_PENALTY_SETTINGS: PenaltySettings = {
  needMode: SETTINGS["penalty.need_overspend_mode"].default,
  overspendPercent: SETTINGS["penalty.overspend_percent"].default,
  wantDeductionOrder: SETTINGS["penalty.want_deduction_order"].default,
  withdrawalExtraPercent: SETTINGS["penalty.withdrawal_extra_percent"].default,
};

export type OverspendPenalty = {
  excessVnd: number;
  penaltyVnd: number;
  limitDeductionVnd: number;
  /** True for a `need` overspend in `warn_only` mode: warn, but no penalty entry. */
  warnOnly: boolean;
};

/**
 * Pure: penalty = excess x percent / 100 in integer VND, rounded half up. A `need`
 * category in `warn_only` mode gets a warning and no penalty. `excessVnd` already has the
 * exception subtracted (budget computes it). Invalid settings fall back to the defaults.
 */
export function computeOverspendPenalty(
  input: { priority: string; weeklyLimitVnd: number; spentVnd: number; excessVnd: number },
  settings: PenaltySettings,
): OverspendPenalty {
  const excessVnd = Number.isInteger(input.excessVnd) && input.excessVnd > 0 ? input.excessVnd : 0;
  const percent =
    Number.isInteger(settings.overspendPercent) &&
    settings.overspendPercent >= 0 &&
    settings.overspendPercent <= 100
      ? settings.overspendPercent
      : DEFAULT_PENALTY_SETTINGS.overspendPercent;
  const mode =
    settings.needMode === "warn_only" || settings.needMode === "penalize"
      ? settings.needMode
      : DEFAULT_PENALTY_SETTINGS.needMode;
  if (input.priority === "need" && mode === "warn_only") {
    return { excessVnd, penaltyVnd: 0, limitDeductionVnd: 0, warnOnly: excessVnd > 0 };
  }
  const penaltyVnd = Math.floor((excessVnd * percent + 50) / 100);
  return { excessVnd, penaltyVnd, limitDeductionVnd: penaltyVnd, warnOnly: false };
}

export type PenaltyLedgerEntry = {
  id: string;
  source: "overspend" | "monitoring" | "routine" | "withdrawal";
  amountVnd: number;
  status: "suspended" | "due" | "paid";
  dueDate: string;
  transferCode: string;
  /** Idempotency key of the fact that caused the penalty. */
  sourceKey: string;
  auditRefs: string[];
  issuedAt: string;
  /** Signed commitment contract in force for the cycle at issuance; null when none exists. */
  contractId: string | null;
  /** Receipt that paid the entry; set when `status` becomes `paid`. */
  paymentTransactionId?: string;
  /** Open appeal that holds the entry: it cannot become due or paid until decided. */
  appealId?: string;
  /** Set when an accepted appeal removed the entry; reversed entries count nowhere. */
  reversedAt?: string;
  /** Set on a withdrawal from penalty savings: a serious violation shown flagged. */
  flagged?: true;
};

export type PenaltyAuditRecord = {
  id: string;
  penaltyId: string;
  action:
    | "penalty.created"
    | "penalty.due"
    | "penalty.paid"
    | "penalty.appeal_hold"
    | "penalty.appeal_released"
    | "penalty.reversed";
  at: string;
  detail: Record<string, unknown>;
};

type Stored = {
  entry: PenaltyLedgerEntry;
  eventPublishedAt: string | null;
  eventClaimed: boolean;
  paidEventPublishedAt: string | null;
  paidEventClaimed: boolean;
};

export type PenaltyPayment = {
  /** Bank reference of the receipt; one reference pays one entry only. */
  bankTransactionRef: string;
  /** Id carried by `penalty.paid` as `transactionId` (the receipt id). */
  transactionId: string;
};

export interface PenaltyStore {
  /** Synchronously inserts the entry with its audit record unless (user, sourceKey) exists. */
  insertOnce(userId: string, entry: PenaltyLedgerEntry, audit: PenaltyAuditRecord): boolean;
  findBySource(userId: string, sourceKey: string): PenaltyLedgerEntry | undefined;
  claimOwedEvent(userId: string, sourceKey: string): PenaltyLedgerEntry | undefined;
  releaseEventClaim(penaltyId: string): void;
  markEventPublished(penaltyId: string, at: string): void;
  /**
   * Synchronously moves a `due` entry to `paid` with its audit record, unless the entry is not
   * `due` or the bank reference was already used by the user. Returns the paid entry.
   */
  markPaid(
    userId: string,
    penaltyId: string,
    payment: PenaltyPayment,
    audit: PenaltyAuditRecord,
  ): PenaltyLedgerEntry | undefined;
  /**
   * Synchronously moves a `suspended` entry to `due` with its audit record and re-arms its owed
   * event, so `penalty.issued` follows. Returns undefined when the entry is not `suspended`.
   */
  markDue(
    userId: string,
    penaltyId: string,
    dueDate: string,
    audit: PenaltyAuditRecord,
  ): PenaltyLedgerEntry | undefined;
  /** Holds an entry for an open appeal; undefined when missing, reversed or already held. */
  holdForAppeal(
    userId: string,
    penaltyId: string,
    appealId: string,
    audit: PenaltyAuditRecord,
  ): PenaltyLedgerEntry | undefined;
  /** Lifts the hold of the appeal (appeal upheld). */
  releaseAppealHold(
    userId: string,
    penaltyId: string,
    appealId: string,
    audit: PenaltyAuditRecord,
  ): PenaltyLedgerEntry | undefined;
  /** Removes the entry held by the appeal (appeal accepted); the entry stays for the audit. */
  reverse(
    userId: string,
    penaltyId: string,
    appealId: string,
    at: string,
    audit: PenaltyAuditRecord,
  ): PenaltyLedgerEntry | undefined;
  claimPaidEvent(userId: string, penaltyId: string): PenaltyLedgerEntry | undefined;
  releasePaidEventClaim(penaltyId: string): void;
  markPaidEventPublished(penaltyId: string, at: string): void;
  list(userId: string): readonly PenaltyLedgerEntry[];
  audit(userId: string): readonly PenaltyAuditRecord[];
}

/** Entries are frozen; a status change replaces the entry and adds an audit record. */
export class InMemoryPenaltyStore implements PenaltyStore {
  private readonly rows = new Map<string, Stored[]>();
  private readonly audits = new Map<string, PenaltyAuditRecord[]>();
  private readonly paidRefs = new Map<string, Set<string>>();

  insertOnce(userId: string, entry: PenaltyLedgerEntry, audit: PenaltyAuditRecord) {
    const list = this.rows.get(userId) ?? [];
    if (list.some((r) => r.entry.sourceKey === entry.sourceKey)) return false;
    list.push({
      entry: Object.freeze(entry),
      eventPublishedAt: null,
      eventClaimed: false,
      paidEventPublishedAt: null,
      paidEventClaimed: false,
    });
    this.rows.set(userId, list);
    this.audits.set(userId, [...(this.audits.get(userId) ?? []), Object.freeze(audit)]);
    return true;
  }
  findBySource(userId: string, sourceKey: string) {
    return this.rows.get(userId)?.find((r) => r.entry.sourceKey === sourceKey)?.entry;
  }
  claimOwedEvent(userId: string, sourceKey: string) {
    const row = this.rows.get(userId)?.find((r) => r.entry.sourceKey === sourceKey);
    if (!row || row.eventPublishedAt !== null || row.eventClaimed) return undefined;
    row.eventClaimed = true;
    return row.entry;
  }
  releaseEventClaim(penaltyId: string) {
    for (const list of this.rows.values())
      for (const r of list) if (r.entry.id === penaltyId) r.eventClaimed = false;
  }
  markEventPublished(penaltyId: string, at: string) {
    for (const list of this.rows.values())
      for (const r of list) if (r.entry.id === penaltyId) r.eventPublishedAt = at;
  }
  markPaid(userId: string, penaltyId: string, payment: PenaltyPayment, audit: PenaltyAuditRecord) {
    const row = this.rows.get(userId)?.find((r) => r.entry.id === penaltyId);
    const refs = this.paidRefs.get(userId) ?? new Set<string>();
    if (
      !row ||
      row.entry.status !== "due" ||
      row.entry.appealId ||
      row.entry.reversedAt ||
      refs.has(payment.bankTransactionRef)
    )
      return undefined;
    refs.add(payment.bankTransactionRef);
    this.paidRefs.set(userId, refs);
    row.entry = Object.freeze({
      ...row.entry,
      status: "paid" as const,
      paymentTransactionId: payment.transactionId,
      auditRefs: [...row.entry.auditRefs, audit.id],
    });
    this.audits.set(userId, [...(this.audits.get(userId) ?? []), Object.freeze(audit)]);
    return row.entry;
  }
  markDue(userId: string, penaltyId: string, dueDate: string, audit: PenaltyAuditRecord) {
    const row = this.rows.get(userId)?.find((r) => r.entry.id === penaltyId);
    if (!row || row.entry.status !== "suspended" || row.entry.appealId || row.entry.reversedAt)
      return undefined;
    row.entry = Object.freeze({
      ...row.entry,
      status: "due" as const,
      dueDate,
      auditRefs: [...row.entry.auditRefs, audit.id],
    });
    // The suspended notice was published; the payment request is a new owed event.
    row.eventPublishedAt = null;
    row.eventClaimed = false;
    this.audits.set(userId, [...(this.audits.get(userId) ?? []), Object.freeze(audit)]);
    return row.entry;
  }
  private change(
    userId: string,
    penaltyId: string,
    audit: PenaltyAuditRecord,
    guard: (e: PenaltyLedgerEntry) => boolean,
    patch: (e: PenaltyLedgerEntry) => PenaltyLedgerEntry,
  ) {
    const row = this.rows.get(userId)?.find((r) => r.entry.id === penaltyId);
    if (!row || !guard(row.entry)) return undefined;
    row.entry = Object.freeze({
      ...patch(row.entry),
      auditRefs: [...row.entry.auditRefs, audit.id],
    });
    this.audits.set(userId, [...(this.audits.get(userId) ?? []), Object.freeze(audit)]);
    return row.entry;
  }
  holdForAppeal(userId: string, penaltyId: string, appealId: string, audit: PenaltyAuditRecord) {
    return this.change(
      userId,
      penaltyId,
      audit,
      (e) => !e.appealId && !e.reversedAt,
      (e) => ({ ...e, appealId }),
    );
  }
  releaseAppealHold(
    userId: string,
    penaltyId: string,
    appealId: string,
    audit: PenaltyAuditRecord,
  ) {
    return this.change(
      userId,
      penaltyId,
      audit,
      (e) => e.appealId === appealId,
      ({ appealId: _held, ...rest }) => rest,
    );
  }
  reverse(
    userId: string,
    penaltyId: string,
    appealId: string,
    at: string,
    audit: PenaltyAuditRecord,
  ) {
    return this.change(
      userId,
      penaltyId,
      audit,
      (e) => e.appealId === appealId,
      ({ appealId: _held, ...rest }) => ({ ...rest, reversedAt: at }),
    );
  }
  claimPaidEvent(userId: string, penaltyId: string) {
    const row = this.rows.get(userId)?.find((r) => r.entry.id === penaltyId);
    if (!row || row.entry.status !== "paid" || row.paidEventPublishedAt !== null) return undefined;
    if (row.paidEventClaimed) return undefined;
    row.paidEventClaimed = true;
    return row.entry;
  }
  releasePaidEventClaim(penaltyId: string) {
    for (const list of this.rows.values())
      for (const r of list) if (r.entry.id === penaltyId) r.paidEventClaimed = false;
  }
  markPaidEventPublished(penaltyId: string, at: string) {
    for (const list of this.rows.values())
      for (const r of list) if (r.entry.id === penaltyId) r.paidEventPublishedAt = at;
  }
  list(userId: string) {
    return (this.rows.get(userId) ?? []).map((r) => r.entry);
  }
  audit(userId: string) {
    return this.audits.get(userId) ?? [];
  }
}

export type PenaltyServiceDeps = {
  store: PenaltyStore;
  trialStore: Pick<TrialStore, "find" | "addSuspended">;
  /** Source of the signed contract carried by new entries; entries get null when absent. */
  contractStore?: Pick<ContractStore, "findSigned">;
  publish?: (event: EventEnvelope) => void | Promise<void>;
  /** Penalty settings in force for the user; registry defaults when absent. */
  readSettings?: (userId: string) => Promise<PenaltySettings>;
  /**
   * Resolves the `MW-PH-C<seq>W<week>-<category>` payment code. The cycle sequence and the
   * category short code live in `budget`; without a resolver a deterministic code is built
   * from the ids.
   */
  resolveTransferCode?: (
    userId: string,
    ref: { cycleId: string; weekIndex: number; categoryId: string },
  ) => Promise<string>;
  /**
   * Tells whether a receipt account hint is the user's penalty savings account. The account
   * codes live in `budget`; without a resolver the seeded code `PEN` (any case) is accepted.
   */
  isPenaltySavingsAccount?: (userId: string, bankAccountHint: string) => Promise<boolean>;
  /** Penalty debt carried over; without it no debt is tracked. */
  debtStore?: PenaltyDebtStore;
  /**
   * The user's `want` categories with the unspent part of the limit, in the user's order.
   * Lives in `budget`; without a reader no source allocation or debt is recorded.
   */
  readWantList?: (
    userId: string,
    ref: { cycleId: string; weekIndex: number },
  ) => Promise<readonly WantLimit[]>;
  dueDays?: number;
  newId?: () => string;
  onPublishError?: (err: unknown) => void;
};

export const DEFAULT_PENALTY_SAVINGS_CODE = "PEN";

/** Uppercase, strip diacritics (including d-stroke) and every non-alphanumeric. Same as budget. */
export function normalizeMemo(memo: string): string {
  return memo
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[đĐ]/g, "D")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export type PaymentResult = { status: "paid"; duplicate: false } | { status: "ignored" };

export type OverspendResult =
  | { status: "none"; warnOnly: boolean; amountVnd: 0; duplicate: false }
  | { status: "suspended" | "due"; warnOnly: false; amountVnd: number; duplicate: boolean };

/** Every method takes `now`; nothing here reads the system clock. */
export function createPenaltyService(deps: PenaltyServiceDeps) {
  const newId = deps.newId ?? randomUUID;
  const readSettings = deps.readSettings ?? (async () => DEFAULT_PENALTY_SETTINGS);
  const dueDays = deps.dueDays ?? DEFAULT_PENALTY_DUE_DAYS;
  const resolveCode =
    deps.resolveTransferCode ??
    (async (_u, r) => `MW-PH-C${r.cycleId.slice(0, 8)}W${r.weekIndex}-${r.categoryId.slice(0, 8)}`);

  async function emitOwed(userId: string, sourceKey: string, now: Date): Promise<void> {
    const e = deps.store.claimOwedEvent(userId, sourceKey);
    if (!e) return;
    const base = { userId, schemaVersion: EVENT_SCHEMA_VERSION, occurredAt: now.toISOString() };
    const ref = { penaltyId: e.id, source: e.source, amountVnd: e.amountVnd };
    // Suspended penalties never send a payment request: only `penalty.suspended` goes out.
    const event =
      e.status === "suspended"
        ? {
            ...base,
            id: `penalty-suspended-${e.id}`,
            type: "penalty.suspended",
            payload: ref satisfies EventPayload<"penalty.suspended">,
          }
        : {
            ...base,
            id: `penalty-issued-${e.id}`,
            type: "penalty.issued",
            payload: {
              ...ref,
              transferCode: e.transferCode,
              dueDate: e.dueDate,
            } satisfies EventPayload<"penalty.issued">,
          };
    try {
      await deps.publish?.(event as EventEnvelope);
      deps.store.markEventPublished(e.id, now.toISOString());
    } catch (err) {
      deps.store.releaseEventClaim(e.id);
      deps.onPublishError?.(err);
    }
  }

  const isPenaltySavings =
    deps.isPenaltySavingsAccount ??
    (async (_u: string, hint: string) =>
      normalizeMemo(hint) === normalizeMemo(DEFAULT_PENALTY_SAVINGS_CODE));

  /**
   * Allocates the penalty plus the debt carried so far over the want list; the shortfall is
   * the new debt. Once per penalty, so a redelivery does not change the balance.
   */
  async function recordSources(
    userId: string,
    entry: PenaltyLedgerEntry,
    ref: { cycleId: string; weekIndex: number },
    order: readonly string[],
    now: Date,
  ): Promise<void> {
    if (!deps.debtStore || !deps.readWantList) return;
    const done = deps.debtStore.find(userId, entry.id);
    if (done) return;
    const wants = await deps.readWantList(userId, ref);
    const carriedInVnd = deps.debtStore.balance(userId);
    const result = allocatePenaltySource({
      penaltyVnd: entry.amountVnd + carriedInVnd,
      wants,
      order,
    });
    deps.debtStore.insertOnce(userId, {
      id: newId(),
      penaltyId: entry.id,
      at: now.toISOString(),
      carriedInVnd,
      penaltyVnd: entry.amountVnd,
      deductions: result.deductions,
      shortfallVnd: result.shortfallVnd,
    });
  }

  async function emitPaid(userId: string, penaltyId: string, now: Date): Promise<void> {
    const e = deps.store.claimPaidEvent(userId, penaltyId);
    if (!e) return;
    try {
      await deps.publish?.({
        id: `penalty-paid-${e.id}`,
        type: "penalty.paid",
        userId,
        schemaVersion: EVENT_SCHEMA_VERSION,
        occurredAt: now.toISOString(),
        payload: {
          penaltyId: e.id,
          source: e.source,
          amountVnd: e.amountVnd,
          transactionId: e.paymentTransactionId!,
        } satisfies EventPayload<"penalty.paid">,
      } as EventEnvelope);
      deps.store.markPaidEventPublished(e.id, now.toISOString());
    } catch (err) {
      deps.store.releasePaidEventClaim(e.id);
      deps.onPublishError?.(err);
    }
  }

  return {
    /**
     * Consumes `receipt.parsed`: an incoming transfer into the penalty savings account whose
     * memo contains the transfer code of a `due` entry and whose amount covers it marks the
     * entry `paid` (audited, once per bank reference) and emits `penalty.paid`. Anything else
     * changes nothing. A failed publish is retried by the next delivery of the receipt.
     */
    async onReceiptParsed(event: EventEnvelope, now: Date): Promise<PaymentResult> {
      const { userId } = event;
      const p = event.payload as EventPayload<"receipt.parsed">;
      const memo = normalizeMemo(p.memo);
      let match: PenaltyLedgerEntry | undefined;
      if (
        p.direction === "in" &&
        memo !== "" &&
        (await isPenaltySavings(userId, p.bankAccountHint))
      ) {
        let best = 0;
        for (const e of deps.store.list(userId)) {
          const code = normalizeMemo(e.transferCode);
          if (
            e.status === "due" &&
            !e.appealId &&
            !e.reversedAt &&
            code !== "" &&
            p.amountVnd >= e.amountVnd &&
            memo.includes(code) &&
            code.length > best
          ) {
            match = e;
            best = code.length;
          }
        }
      }
      if (!match) {
        // A receipt already booked may still owe its event after a failed publish.
        const paid = deps.store
          .list(userId)
          .find((e) => e.paymentTransactionId === p.receiptId && e.status === "paid");
        if (paid) await emitPaid(userId, paid.id, now);
        return { status: "ignored" };
      }
      const audit: PenaltyAuditRecord = {
        id: newId(),
        penaltyId: match.id,
        action: "penalty.paid",
        at: now.toISOString(),
        detail: {
          sourceEventId: event.id,
          receiptId: p.receiptId,
          bankTransactionRef: p.bankTransactionRef,
          paidVnd: p.amountVnd,
          penaltyVnd: match.amountVnd,
          transferCode: match.transferCode,
        },
      };
      const paid = deps.store.markPaid(
        userId,
        match.id,
        { bankTransactionRef: p.bankTransactionRef, transactionId: p.receiptId },
        audit,
      );
      if (!paid) return { status: "ignored" };
      await emitPaid(userId, paid.id, now);
      return { status: "paid", duplicate: false };
    },

    /**
     * Trial settlement: each settled suspended entry becomes `due` (audited) and `penalty.issued`
     * goes out. The due date is the later of the usual due window and the last installment, so
     * the whole amount stays payable. Idempotent: entries that are not suspended are skipped.
     */
    async onTrialSettled(userId: string, lines: SettlementLine[], now: Date): Promise<void> {
      for (const line of lines) {
        const entry = deps.store.list(userId).find((e) => e.id === line.entryId);
        if (!entry) continue;
        const lastInstallment = Math.max(
          0,
          ...line.installments.map((i) => Date.parse(i.dueDate)).filter(Number.isFinite),
        );
        const dueDate = new Date(
          Math.max(now.getTime() + dueDays * DAY_MS, lastInstallment),
        ).toISOString();
        const audit: PenaltyAuditRecord = {
          id: newId(),
          penaltyId: entry.id,
          action: "penalty.due",
          at: now.toISOString(),
          detail: {
            reason: "trial_settled",
            installments: line.installments,
            amountVnd: entry.amountVnd,
          },
        };
        deps.store.markDue(userId, entry.id, dueDate, audit);
        // Also covers an owed event that failed to publish on an earlier run.
        await emitOwed(userId, entry.sourceKey, now);
      }
    },

    /**
     * Consumes `overspend.detected`: computes the penalty from the user's settings, writes
     * one ledger entry with its audit record, then emits `penalty.suspended` while the
     * trial runs and `penalty.issued` (status `due`) after it.
     */
    async onOverspendDetected(event: EventEnvelope, now: Date): Promise<OverspendResult> {
      const { userId } = event;
      const p = event.payload as EventPayload<"overspend.detected">;
      const sourceKey = `overspend:${p.cycleId}:${p.weekIndex}:${p.categoryId}`;
      const existing = deps.store.findBySource(userId, sourceKey);
      if (existing) {
        await recordSources(
          userId,
          existing,
          p,
          (await readSettings(userId)).wantDeductionOrder ?? [],
          now,
        );
        await emitOwed(userId, sourceKey, now);
        return {
          status: existing.status === "suspended" ? "suspended" : "due",
          warnOnly: false,
          amountVnd: existing.amountVnd,
          duplicate: true,
        };
      }

      const settings = await readSettings(userId);
      const result = computeOverspendPenalty(
        {
          priority: p.priority,
          weeklyLimitVnd: p.weeklyLimitVnd,
          spentVnd: p.spentVnd,
          excessVnd: p.excessVnd,
        },
        settings,
      );
      if (result.penaltyVnd <= 0) {
        return { status: "none", warnOnly: result.warnOnly, amountVnd: 0, duplicate: false };
      }

      const trial = deps.trialStore.find(userId);
      const inTrial =
        trial !== undefined && trial.state === "active" && now.getTime() < Date.parse(trial.endsAt);
      const id = newId();
      const entry: PenaltyLedgerEntry = {
        id,
        source: "overspend",
        amountVnd: result.penaltyVnd,
        status: inTrial ? "suspended" : "due",
        dueDate: new Date(now.getTime() + dueDays * DAY_MS).toISOString(),
        transferCode: await resolveCode(userId, p),
        sourceKey,
        auditRefs: [],
        issuedAt: now.toISOString(),
        contractId: deps.contractStore?.findSigned(userId, p.cycleId)?.id ?? null,
      };
      const audit: PenaltyAuditRecord = {
        id: newId(),
        penaltyId: id,
        action: "penalty.created",
        at: now.toISOString(),
        detail: {
          sourceEventId: event.id,
          sourceKey,
          priority: p.priority,
          excessVnd: result.excessVnd,
          percent: settings.overspendPercent,
          needMode: settings.needMode,
          status: entry.status,
        },
      };
      entry.auditRefs.push(audit.id);
      const inserted = deps.store.insertOnce(userId, entry, audit);
      if (inserted && inTrial) {
        deps.trialStore.addSuspended(userId, [
          { id, source: "overspend", amountVnd: entry.amountVnd },
        ]);
      }
      await recordSources(userId, entry, p, settings.wantDeductionOrder ?? [], now);
      await emitOwed(userId, sourceKey, now);
      return {
        status: entry.status,
        warnOnly: false,
        amountVnd: entry.amountVnd,
        duplicate: !inserted,
      } as OverspendResult;
    },

    /**
     * Issues one monitoring penalty computed by the weekly job (the amount is already decided
     * by code from recorded fault points). One ledger entry with its audit record per
     * `sourceKey`; suspended during the trial, otherwise `due`. A repeat call adds no entry and
     * only re-sends an event that is still owed. Money is not allocated from the want list here.
     */
    async issueMonitoring(
      userId: string,
      input: {
        sourceKey: string;
        amountVnd: number;
        transferCode: string;
        detail: Record<string, unknown>;
      },
      now: Date,
    ): Promise<{ penaltyId: string; status: "suspended" | "due"; duplicate: boolean }> {
      const existing = deps.store.findBySource(userId, input.sourceKey);
      if (existing) {
        await emitOwed(userId, input.sourceKey, now);
        return {
          penaltyId: existing.id,
          status: existing.status === "suspended" ? "suspended" : "due",
          duplicate: true,
        };
      }
      const trial = deps.trialStore.find(userId);
      const inTrial =
        trial !== undefined && trial.state === "active" && now.getTime() < Date.parse(trial.endsAt);
      const id = newId();
      const entry: PenaltyLedgerEntry = {
        id,
        source: "monitoring",
        amountVnd: input.amountVnd,
        status: inTrial ? "suspended" : "due",
        dueDate: new Date(now.getTime() + dueDays * DAY_MS).toISOString(),
        transferCode: input.transferCode,
        sourceKey: input.sourceKey,
        auditRefs: [],
        issuedAt: now.toISOString(),
        contractId: null,
      };
      const audit: PenaltyAuditRecord = {
        id: newId(),
        penaltyId: id,
        action: "penalty.created",
        at: now.toISOString(),
        detail: { ...input.detail, sourceKey: input.sourceKey, status: entry.status },
      };
      entry.auditRefs.push(audit.id);
      const inserted = deps.store.insertOnce(userId, entry, audit);
      if (inserted && inTrial) {
        deps.trialStore.addSuspended(userId, [
          { id, source: "monitoring", amountVnd: entry.amountVnd },
        ]);
      }
      await emitOwed(userId, input.sourceKey, now);
      return {
        penaltyId: id,
        status: entry.status === "suspended" ? "suspended" : "due",
        duplicate: !inserted,
      };
    },

    /**
     * Consumes `penalty_savings.withdrawal_detected`: money left the penalty savings account.
     * The user repays it and pays `penalty.withdrawal_extra_percent` extra, so one flagged
     * `withdrawal` entry of repayment plus extra is issued (suspended during the trial, like
     * every penalty). Once per bank transaction, or per event when a balance reconciliation
     * found it without one. It is not taken from the want list and creates no debt.
     */
    async onWithdrawalDetected(event: EventEnvelope, now: Date): Promise<OverspendResult> {
      const { userId } = event;
      const p = event.payload as EventPayload<"penalty_savings.withdrawal_detected">;
      const sourceKey = `withdrawal:${p.bankAccountId}:${p.transactionId ?? `event:${event.id}`}`;
      const existing = deps.store.findBySource(userId, sourceKey);
      if (existing) {
        await emitOwed(userId, sourceKey, now);
        return {
          status: existing.status === "suspended" ? "suspended" : "due",
          warnOnly: false,
          amountVnd: existing.amountVnd,
          duplicate: true,
        };
      }
      const settings = await readSettings(userId);
      const extraPercent =
        settings.withdrawalExtraPercent ?? DEFAULT_WITHDRAWAL_SETTINGS.extraPercent;
      const result = computeWithdrawalPenalty(p.amountVnd, { extraPercent });
      if (result.totalVnd <= 0) {
        return { status: "none", warnOnly: false, amountVnd: 0, duplicate: false };
      }
      const trial = deps.trialStore.find(userId);
      const inTrial =
        trial !== undefined && trial.state === "active" && now.getTime() < Date.parse(trial.endsAt);
      const id = newId();
      const entry: PenaltyLedgerEntry = {
        id,
        source: "withdrawal",
        amountVnd: result.totalVnd,
        status: inTrial ? "suspended" : "due",
        dueDate: new Date(now.getTime() + dueDays * DAY_MS).toISOString(),
        transferCode: `MW-PH-WD-${(p.transactionId ?? event.id).replace(/-/g, "").slice(0, 8)}`,
        sourceKey,
        auditRefs: [],
        issuedAt: now.toISOString(),
        contractId: null,
        flagged: true,
      };
      const audit: PenaltyAuditRecord = {
        id: newId(),
        penaltyId: id,
        action: "penalty.created",
        at: now.toISOString(),
        detail: {
          sourceEventId: event.id,
          sourceKey,
          flagged: true,
          bankAccountId: p.bankAccountId,
          transactionId: p.transactionId,
          detectedBy: p.detectedBy,
          repaymentVnd: result.repaymentVnd,
          extraVnd: result.extraVnd,
          extraPercent,
          status: entry.status,
        },
      };
      entry.auditRefs.push(audit.id);
      const inserted = deps.store.insertOnce(userId, entry, audit);
      if (inserted && inTrial) {
        deps.trialStore.addSuspended(userId, [
          { id, source: "withdrawal", amountVnd: entry.amountVnd },
        ]);
      }
      await emitOwed(userId, sourceKey, now);
      return {
        status: entry.status,
        warnOnly: false,
        amountVnd: entry.amountVnd,
        duplicate: !inserted,
      } as OverspendResult;
    },
  };
}

export type PenaltyService = ReturnType<typeof createPenaltyService>;
