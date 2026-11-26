import { randomUUID } from "node:crypto";
import {
  EVENT_SCHEMA_VERSION,
  SETTINGS,
  type EventEnvelope,
  type EventPayload,
} from "@my-wife/contracts";
import type { TrialStore } from "./trial";

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
};

export const DEFAULT_PENALTY_SETTINGS: PenaltySettings = {
  needMode: SETTINGS["penalty.need_overspend_mode"].default,
  overspendPercent: SETTINGS["penalty.overspend_percent"].default,
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
};

export type PenaltyAuditRecord = {
  id: string;
  penaltyId: string;
  action: "penalty.created";
  at: string;
  detail: Record<string, unknown>;
};

type Stored = {
  entry: PenaltyLedgerEntry;
  eventPublishedAt: string | null;
  eventClaimed: boolean;
};

export interface PenaltyStore {
  /** Synchronously inserts the entry with its audit record unless (user, sourceKey) exists. */
  insertOnce(userId: string, entry: PenaltyLedgerEntry, audit: PenaltyAuditRecord): boolean;
  findBySource(userId: string, sourceKey: string): PenaltyLedgerEntry | undefined;
  claimOwedEvent(userId: string, sourceKey: string): PenaltyLedgerEntry | undefined;
  releaseEventClaim(penaltyId: string): void;
  markEventPublished(penaltyId: string, at: string): void;
  list(userId: string): readonly PenaltyLedgerEntry[];
  audit(userId: string): readonly PenaltyAuditRecord[];
}

/** Append-only: entries are frozen; later status changes belong to other issues. */
export class InMemoryPenaltyStore implements PenaltyStore {
  private readonly rows = new Map<string, Stored[]>();
  private readonly audits = new Map<string, PenaltyAuditRecord[]>();

  insertOnce(userId: string, entry: PenaltyLedgerEntry, audit: PenaltyAuditRecord) {
    const list = this.rows.get(userId) ?? [];
    if (list.some((r) => r.entry.sourceKey === entry.sourceKey)) return false;
    list.push({ entry: Object.freeze(entry), eventPublishedAt: null, eventClaimed: false });
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
  dueDays?: number;
  newId?: () => string;
  onPublishError?: (err: unknown) => void;
};

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

  return {
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
