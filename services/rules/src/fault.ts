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
  /** `admin.incident_waiver_default`: waive faults inside admin incidents. Absent means default. */
  incidentWaiver?: boolean;
};

/** An admin incident as the rules service knows it (from `incident.*` events). */
export type IncidentWindow = {
  id: string;
  state: "declared" | "active" | "ended" | "cancelled";
  startsAt: string;
  endsAt: string | null;
  scope: "all" | readonly string[];
};

/**
 * Pure: the first non-cancelled incident whose window (inclusive) holds `occurredAt` and
 * whose scope includes the user. An open-ended incident covers every later time.
 */
export function findCoveringIncident(
  occurredAt: string,
  userId: string,
  incidents: readonly IncidentWindow[],
): IncidentWindow | undefined {
  const t = Date.parse(occurredAt);
  return incidents.find(
    (i) =>
      i.state !== "cancelled" &&
      t >= Date.parse(i.startsAt) &&
      (i.endsAt === null || t <= Date.parse(i.endsAt)) &&
      (i.scope === "all" || i.scope.includes(userId)),
  );
}

export type WaivedFaultReport = {
  items: { faultId: string; type: FaultType; occurredAt: string; points: number; cause: string }[];
  totalPointsWaived: number;
};

/** Pure: system-waived faults with occurredAt in [from, to), for the weekly report. */
export function summarizeWaivedFaults(
  faults: readonly FaultEntry[],
  from: Date,
  to: Date,
): WaivedFaultReport {
  const items = faults
    .filter((f) => {
      const t = Date.parse(f.occurredAt);
      return f.status === "waived_system" && t >= from.getTime() && t < to.getTime();
    })
    .map((f) => ({
      faultId: f.id,
      type: f.type,
      occurredAt: f.occurredAt,
      points: f.points,
      cause: f.waiver ?? "heartbeat_gap_outage",
    }));
  return { items, totalPointsWaived: items.reduce((a, i) => a + i.points, 0) };
}

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
  incidentWaiver: SETTINGS["admin.incident_waiver_default"].default,
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

/** Sort and cursor key of a fault: occurrence time, then id as the tie-breaker. */
export function faultPageKey(e: Pick<FaultEntry, "occurredAt" | "id">): string {
  return `${e.occurredAt}|${e.id}`;
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
    patch?: Pick<FaultLedgerEntry, "waiver" | "systemCause">,
  ): FaultLedgerEntry | undefined;
  /** Every user that has at least one ledger entry. */
  listUserIds(): readonly string[];
  /** Honest-reason faults of the type with occurredAt in (from, to]. */
  countHonest(userId: string, type: FaultType, from: Date, to: Date): number;
  claimOwedEvent(userId: string, signalRef: string): Stored | undefined;
  releaseEventClaim(faultId: string): void;
  markEventPublished(faultId: string, at: string): void;
  list(userId: string): readonly FaultLedgerEntry[];
  /**
   * Newest-first keyset page ordered by (occurredAt, id). `after` is the `next` key of the
   * previous page; `next` is null on the last page. A persistent implementation must back
   * this with an index on (user_id, occurred_at DESC, id DESC).
   */
  listPage(
    userId: string,
    limit: number,
    after: string | null,
  ): { items: readonly FaultLedgerEntry[]; next: string | null };
  audit(userId: string): readonly FaultAuditRecord[];
}

/** Append-only: entries are frozen and the store has no update or delete. */
export class InMemoryFaultStore implements FaultStore {
  private readonly rows = new Map<string, Stored[]>();
  private readonly audits = new Map<string, FaultAuditRecord[]>();
  /** Per-user rows kept sorted by key descending, maintained on insert (the in-memory index). */
  private readonly byRecency = new Map<string, Stored[]>();

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
    const index = this.byRecency.get(userId) ?? [];
    const row = list[list.length - 1]!;
    // Binary search for the first position whose key is smaller (descending order).
    let lo = 0;
    let hi = index.length;
    const key = faultPageKey(entry);
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (faultPageKey(index[mid]!.entry) > key) lo = mid + 1;
      else hi = mid;
    }
    index.splice(lo, 0, row);
    this.byRecency.set(userId, index);
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
    patch?: Pick<FaultLedgerEntry, "waiver" | "systemCause">,
  ) {
    const row = this.rows.get(userId)?.find((r) => r.entry.id === faultId);
    if (!row || !from.includes(row.entry.status)) return undefined;
    row.entry = Object.freeze({ ...row.entry, ...patch, status: to });
    this.audits.set(userId, [...(this.audits.get(userId) ?? []), Object.freeze(audit)]);
    return row.entry;
  }
  listUserIds() {
    return [...this.rows.keys()];
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
  listPage(userId: string, limit: number, after: string | null) {
    const index = this.byRecency.get(userId) ?? [];
    let lo = 0;
    if (after !== null) {
      let hi = index.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (faultPageKey(index[mid]!.entry) >= after) lo = mid + 1;
        else hi = mid;
      }
    }
    const items = index.slice(lo, lo + limit).map((r) => r.entry);
    const last = items[items.length - 1];
    const next = last !== undefined && lo + limit < index.length ? faultPageKey(last) : null;
    return { items, next };
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
  /** Admin incidents known to the service (declared, active, ended, cancelled). */
  listIncidents?: (userId: string) => Promise<readonly IncidentWindow[]>;
  newId?: () => string;
  onPublishError?: (err: unknown) => void;
};

/** Every method takes `now`; nothing here reads the system clock. */
export function createFaultService(deps: FaultServiceDeps) {
  const newId = deps.newId ?? randomUUID;
  const listIncidents = deps.listIncidents ?? (async () => []);
  const readSettings = deps.readSettings ?? (async () => DEFAULT_FAULT_SETTINGS);
  /** Incidents learned from `incident.*` events, by id. */
  const known = new Map<string, IncidentWindow>();
  const allIncidents = async (userId: string): Promise<readonly IncidentWindow[]> => [
    ...known.values(),
    ...(await listIncidents(userId)),
  ];

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

  /**
   * Waives the user's `recorded` faults that fall in the incident window. Only the
   * recorded -> waived_system transition is allowed, so a repeat finds nothing to do.
   */
  async function waiveOverlapping(
    userId: string,
    incident: IncidentWindow,
    sourceEventId: string,
    now: Date,
  ): Promise<number> {
    let waived = 0;
    for (const f of deps.store.list(userId)) {
      if (f.status !== "recorded") continue;
      if (!findCoveringIncident(f.occurredAt, userId, [incident])) continue;
      const settings = await readSettings(userId, new Date(f.occurredAt));
      if (!(settings.incidentWaiver ?? DEFAULT_FAULT_SETTINGS.incidentWaiver)) continue;
      const moved = deps.store.transition(
        userId,
        f.id,
        ["recorded"],
        "waived_system",
        {
          id: newId(),
          faultId: f.id,
          action: "fault.waived_system",
          at: now.toISOString(),
          detail: { sourceEventId, incidentId: incident.id, points: f.points },
        },
        { waiver: "admin_incident", systemCause: `incident:${incident.id}` },
      );
      if (!moved) continue;
      waived++;
      try {
        await deps.publish?.({
          id: `fault-waived-${f.id}`,
          userId,
          schemaVersion: EVENT_SCHEMA_VERSION,
          type: "fault.waived",
          occurredAt: now.toISOString(),
          payload: {
            faultId: f.id,
            cause: "admin_incident",
            kind: "system",
          } satisfies EventPayload<"fault.waived">,
        } as EventEnvelope);
      } catch (err) {
        deps.onPublishError?.(err);
      }
    }
    return waived;
  }

  return {
    /**
     * Consumes `incident.declared`, `incident.ended` and `incident.cancelled`. Remembers the
     * window (so later faults inside it are waived at detection) and waives the recorded
     * faults it overlaps. Idempotent: a redelivery changes nothing. A cancelled incident stops
     * waiving new faults; waivers already granted stay (undoing them is a manual decision).
     */
    async onIncidentEvent(event: EventEnvelope, now: Date): Promise<{ waived: number }> {
      let incident: IncidentWindow;
      if (event.type === "incident.declared") {
        const p = event.payload as EventPayload<"incident.declared">;
        const prior = known.get(p.incidentId);
        if (prior && (prior.state === "cancelled" || prior.state === "ended")) return { waived: 0 };
        incident = {
          id: p.incidentId,
          state: "declared",
          startsAt: p.startsAt,
          endsAt: p.endsAt,
          scope: p.scope,
        };
      } else if (event.type === "incident.ended") {
        const p = event.payload as EventPayload<"incident.ended">;
        const prior = known.get(p.incidentId);
        if (!prior || prior.state === "cancelled") return { waived: 0 };
        incident = { ...prior, state: "ended", endsAt: p.endsAt };
      } else if (event.type === "incident.cancelled") {
        const p = event.payload as EventPayload<"incident.cancelled">;
        const prior = known.get(p.incidentId);
        if (prior) known.set(p.incidentId, { ...prior, state: "cancelled" });
        return { waived: 0 };
      } else {
        return { waived: 0 };
      }
      known.set(incident.id, incident);
      const users =
        incident.scope === "all" ? deps.store.listUserIds() : [...new Set(incident.scope)];
      let waived = 0;
      for (const userId of users) waived += await waiveOverlapping(userId, incident, event.id, now);
      return { waived };
    },

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
      const incident =
        !p.overlapsOutage && (settings.incidentWaiver ?? DEFAULT_FAULT_SETTINGS.incidentWaiver)
          ? findCoveringIncident(p.occurredAt, userId, await allIncidents(userId))
          : undefined;
      const waived = p.overlapsOutage || incident !== undefined;
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
        waiver: !waived ? null : incident ? "admin_incident" : "heartbeat_gap_outage",
        systemCause: !waived ? null : incident ? `incident:${incident.id}` : "overlaps_outage",
        honestReason: reason === "honest",
      };
      const audit: FaultAuditRecord = {
        id: newId(),
        faultId: id,
        action: waived ? "fault.waived_system" : "fault.recorded",
        at: now.toISOString(),
        detail: {
          sourceEventId: event.id,
          signalRef: p.signalRef,
          reason,
          weightSnapshot,
          points,
          incidentId: incident?.id ?? null,
        },
      };
      const inserted = deps.store.insertOnce(userId, entry, audit);
      await emitOwed(userId, p.signalRef, now);
      return { status: entry.status, duplicate: !inserted };
    },
  };
}

export type FaultService = ReturnType<typeof createFaultService>;
