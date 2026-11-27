import { randomUUID } from "node:crypto";
import {
  EVENT_SCHEMA_VERSION,
  SETTINGS,
  type EventEnvelope,
  type EventPayload,
  type FaultEntry,
  type FaultType,
} from "@my-wife/contracts";

const WEEK_MS = 7 * 24 * 3_600_000;

/** Fault scoring settings of one user. Values come from the settings API; defaults from the registry. */
export type FaultSettings = {
  weights: Record<FaultType, number>;
  honestPercent: number;
  silentPercent: number;
  quotaPerWeek: number;
};

export const DEFAULT_FAULT_SETTINGS: FaultSettings = {
  weights: {
    heartbeat_lost: SETTINGS["fault.weight.heartbeat_lost"].default,
    camera_off: SETTINGS["fault.weight.camera_off"].default,
    no_face: SETTINGS["fault.weight.no_face"].default,
    tab_away: SETTINGS["fault.weight.tab_away"].default,
    wake_late: SETTINGS["fault.weight.wake_late"].default,
    bedtime_missed: SETTINGS["fault.weight.bedtime_missed"].default,
  },
  honestPercent: SETTINGS["fault.reason_multiplier_percent.honest"].default,
  silentPercent: SETTINGS["fault.reason_multiplier_percent.silent"].default,
  quotaPerWeek: SETTINGS["reason.quota_per_week"].default,
};

export type FaultReasonKind = "none" | "honest" | "quota_exceeded";

/**
 * Pure: points = weight * multiplier percent, in integer arithmetic, rounded half up.
 * `none` and `quota_exceeded` both score as silent.
 */
export function scoreFault(
  input: { type: FaultType; reason: FaultReasonKind },
  settings: FaultSettings,
): { weightSnapshot: number; points: number } {
  const defaults = DEFAULT_FAULT_SETTINGS;
  const valid = (n: number) => Number.isInteger(n) && n >= 0;
  const weight = valid(settings.weights[input.type])
    ? settings.weights[input.type]
    : defaults.weights[input.type];
  const honest = valid(settings.honestPercent) ? settings.honestPercent : defaults.honestPercent;
  const silent = valid(settings.silentPercent) ? settings.silentPercent : defaults.silentPercent;
  const percent = input.reason === "honest" ? honest : silent;
  return { weightSnapshot: weight, points: Math.floor((weight * percent + 50) / 100) };
}

export type FaultLedgerEntry = FaultEntry & { honestReason: boolean };

export type FaultAuditRecord = {
  id: string;
  faultId: string;
  action:
    | "fault.recorded"
    | "fault.waived_system"
    | "fault.appealed"
    | "fault.upheld"
    | "fault.overturned";
  at: string;
  detail: Record<string, unknown>;
};

type Stored = {
  entry: FaultLedgerEntry;
  eventType: "fault.recorded" | "fault.waived";
  eventPublishedAt: string | null;
  eventClaimed: boolean;
};

export interface FaultStore {
  /** Synchronously inserts the entry with its audit record unless (user, signalRef) exists. */
  insertOnce(userId: string, entry: FaultLedgerEntry, audit: FaultAuditRecord): boolean;
  findBySignal(userId: string, signalRef: string): FaultLedgerEntry | undefined;
  /**
   * Synchronously moves the entry from one of the `from` statuses to `to` with its audit
   * record. Returns undefined when the entry is missing or in another status.
   */
  transition(
    userId: string,
    faultId: string,
    from: readonly FaultLedgerEntry["status"][],
    to: FaultLedgerEntry["status"],
    audit: FaultAuditRecord,
  ): FaultLedgerEntry | undefined;
  /** Honest-reason faults of the type with occurredAt in (from, to]. */
  countHonest(userId: string, type: FaultType, from: Date, to: Date): number;
  claimOwedEvent(userId: string, signalRef: string): Stored | undefined;
  releaseEventClaim(faultId: string): void;
  markEventPublished(faultId: string, at: string): void;
  list(userId: string): readonly FaultLedgerEntry[];
  audit(userId: string): readonly FaultAuditRecord[];
}

/** Append-only: entries are frozen and the store has no update or delete. */
export class InMemoryFaultStore implements FaultStore {
  private readonly rows = new Map<string, Stored[]>();
  private readonly audits = new Map<string, FaultAuditRecord[]>();

  insertOnce(userId: string, entry: FaultLedgerEntry, audit: FaultAuditRecord) {
    const list = this.rows.get(userId) ?? [];
    if (list.some((r) => r.entry.signalRef === entry.signalRef)) return false;
    list.push({
      entry: Object.freeze(entry),
      eventType: entry.status === "waived_system" ? "fault.waived" : "fault.recorded",
      eventPublishedAt: null,
      eventClaimed: false,
    });
    this.rows.set(userId, list);
    this.audits.set(userId, [...(this.audits.get(userId) ?? []), Object.freeze(audit)]);
    return true;
  }
  findBySignal(userId: string, signalRef: string) {
    return this.rows.get(userId)?.find((r) => r.entry.signalRef === signalRef)?.entry;
  }
  transition(
    userId: string,
    faultId: string,
    from: readonly FaultLedgerEntry["status"][],
    to: FaultLedgerEntry["status"],
    audit: FaultAuditRecord,
  ) {
    const row = this.rows.get(userId)?.find((r) => r.entry.id === faultId);
    if (!row || !from.includes(row.entry.status)) return undefined;
    row.entry = Object.freeze({ ...row.entry, status: to });
    this.audits.set(userId, [...(this.audits.get(userId) ?? []), Object.freeze(audit)]);
    return row.entry;
  }
  countHonest(userId: string, type: FaultType, from: Date, to: Date) {
    return (this.rows.get(userId) ?? []).filter((r) => {
      const t = Date.parse(r.entry.occurredAt);
      return (
        r.entry.type === type && r.entry.honestReason && t > from.getTime() && t <= to.getTime()
      );
    }).length;
  }
  claimOwedEvent(userId: string, signalRef: string) {
    const row = this.rows.get(userId)?.find((r) => r.entry.signalRef === signalRef);
    if (!row || row.eventPublishedAt !== null || row.eventClaimed) return undefined;
    row.eventClaimed = true;
    return row;
  }
  releaseEventClaim(faultId: string) {
    for (const list of this.rows.values())
      for (const r of list) if (r.entry.id === faultId) r.eventClaimed = false;
  }
  markEventPublished(faultId: string, at: string) {
    for (const list of this.rows.values())
      for (const r of list) if (r.entry.id === faultId) r.eventPublishedAt = at;
  }
  list(userId: string) {
    return (this.rows.get(userId) ?? []).map((r) => r.entry);
  }
  audit(userId: string) {
    return this.audits.get(userId) ?? [];
  }
}

export type FaultServiceDeps = {
  store: FaultStore;
  publish?: (event: EventEnvelope) => void | Promise<void>;
  /** Settings in force at `at` (point-in-time); registry defaults when absent. */
  readSettings?: (userId: string, at: Date) => Promise<FaultSettings>;
  newId?: () => string;
  onPublishError?: (err: unknown) => void;
};

/** Every method takes `now`; nothing here reads the system clock. */
export function createFaultService(deps: FaultServiceDeps) {
  const newId = deps.newId ?? randomUUID;
  const readSettings = deps.readSettings ?? (async () => DEFAULT_FAULT_SETTINGS);

  async function emitOwed(userId: string, signalRef: string, now: Date): Promise<void> {
    const row = deps.store.claimOwedEvent(userId, signalRef);
    if (!row) return;
    const e = row.entry;
    // Deterministic id per fault: a retry after an ambiguous publish carries the same id,
    // so the bus can deduplicate it.
    const eventId = `${row.eventType === "fault.recorded" ? "fault-recorded" : "fault-waived"}-${e.id}`;
    const base = { id: eventId, userId, schemaVersion: EVENT_SCHEMA_VERSION };
    const event =
      row.eventType === "fault.recorded"
        ? {
            ...base,
            type: "fault.recorded",
            occurredAt: now.toISOString(),
            payload: {
              faultId: e.id,
              type: e.type,
              points: e.points,
              occurredAt: e.occurredAt,
            } satisfies EventPayload<"fault.recorded">,
          }
        : {
            ...base,
            type: "fault.waived",
            occurredAt: now.toISOString(),
            payload: {
              faultId: e.id,
              cause: e.waiver ?? "heartbeat_gap_outage",
              kind: "system",
            } satisfies EventPayload<"fault.waived">,
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
     * Consumes `fault.detected`: scores it with the settings in force at `occurredAt`,
     * writes the ledger entry and its audit record once per signal, then emits the event.
     */
    async onFaultDetected(
      event: EventEnvelope,
      now: Date,
    ): Promise<{ status: FaultLedgerEntry["status"]; duplicate: boolean }> {
      const { userId } = event;
      const p = event.payload as EventPayload<"fault.detected">;
      const existing = deps.store.findBySignal(userId, p.signalRef);
      if (existing) {
        await emitOwed(userId, p.signalRef, now);
        return { status: existing.status, duplicate: true };
      }

      const occurredAt = new Date(p.occurredAt);
      const settings = await readSettings(userId, occurredAt);
      let reason: FaultReasonKind = "none";
      if (p.reason === "given") {
        const used = deps.store.countHonest(
          userId,
          p.type,
          new Date(occurredAt.getTime() - WEEK_MS),
          occurredAt,
        );
        reason = used >= settings.quotaPerWeek ? "quota_exceeded" : "honest";
      }
      const { weightSnapshot, points } = scoreFault({ type: p.type, reason }, settings);
      const waived = p.overlapsOutage;
      const id = newId();
      const entry: FaultLedgerEntry = {
        id,
        type: p.type,
        occurredAt: p.occurredAt,
        signalRef: p.signalRef,
        reasonRef: p.reasonRef,
        weightSnapshot,
        points,
        status: waived ? "waived_system" : "recorded",
        waiver: waived ? "heartbeat_gap_outage" : null,
        systemCause: waived ? "overlaps_outage" : null,
        honestReason: reason === "honest",
      };
      const audit: FaultAuditRecord = {
        id: newId(),
        faultId: id,
        action: waived ? "fault.waived_system" : "fault.recorded",
        at: now.toISOString(),
        detail: { sourceEventId: event.id, signalRef: p.signalRef, reason, weightSnapshot, points },
      };
      const inserted = deps.store.insertOnce(userId, entry, audit);
      await emitOwed(userId, p.signalRef, now);
      return { status: entry.status, duplicate: !inserted };
    },
  };
}

export type FaultService = ReturnType<typeof createFaultService>;
