import { randomUUID } from "node:crypto";
import {
  EVENT_SCHEMA_VERSION,
  SETTINGS,
  type EventEnvelope,
  type EventPayload,
} from "@my-wife/contracts";

const HOUR_MS = 3_600_000;
const WEEK_MS = 7 * 24 * HOUR_MS;

/** Trial settings of one user; every field defaults to the registry value. */
export type TrialSettings = {
  weeks: number;
  installmentsK: number;
  finalAppealHours: number;
  /** Gap between installments; one week keeps them aligned with the weekly cycle. */
  installmentIntervalMs?: number;
};

export const DEFAULT_TRIAL_SETTINGS: TrialSettings = {
  weeks: SETTINGS["trial.weeks"].default,
  installmentsK: SETTINGS["trial.installments_k"].default,
  finalAppealHours: SETTINGS["trial.final_appeal_hours"].default,
};

export type SuspendedEntry = {
  id: string;
  source: "overspend" | "monitoring" | "routine" | "withdrawal";
  amountVnd: number;
  /** An open appeal keeps the entry suspended; it is settled once the appeal is decided. */
  appealOpen?: boolean;
};

export type Installment = { amountVnd: number; dueDate: string };
export type SettlementLine = { entryId: string; installments: Installment[] };

/** The trial clock is independent of cycles: start + `weeks` whole weeks. */
export function computeTrialEnd(start: Date, weeks: number): Date {
  return new Date(start.getTime() + weeks * WEEK_MS);
}

export function computeFinalAppealEnd(trialEnd: Date, finalAppealHours: number): Date {
  return new Date(trialEnd.getTime() + finalAppealHours * HOUR_MS);
}

/**
 * Turns suspended entries into a real payment schedule: one payment, or K equal
 * installments (the remainder of the integer split goes to the last one).
 * Entries with an open appeal are left out.
 */
export function settleTrial(input: {
  entries: SuspendedEntry[];
  installmentsK: number;
  settledAt: Date;
  installmentIntervalMs?: number;
}): SettlementLine[] {
  const k = input.installmentsK;
  const gap = input.installmentIntervalMs ?? WEEK_MS;
  return input.entries
    .filter((e) => !e.appealOpen)
    .map((e) => {
      const base = Math.floor(e.amountVnd / k);
      const installments = Array.from({ length: k }, (_, i) => ({
        amountVnd: i === k - 1 ? e.amountVnd - base * (k - 1) : base,
        dueDate: new Date(input.settledAt.getTime() + i * gap).toISOString(),
      }));
      return { entryId: e.id, installments };
    });
}

export type TrialEndReason = "elapsed" | "turned_off" | "account_closing";

export type TrialState = "active" | "final_appeal" | "settled";

export type TrialRecord = {
  userId: string;
  settings: TrialSettings;
  startedAt: string;
  endsAt: string;
  state: TrialState;
  finalAppealEndsAt?: string;
  /** Why the trial ended; `elapsed` when the clock ran out. */
  endReason?: TrialEndReason;
  suspendedTotalVnd?: number;
  settledTotalVnd?: number;
  startedPublished: boolean;
  endedPublished: boolean;
  settledPublished: boolean;
};

export type LedgerEntry = SuspendedEntry & {
  status: "suspended" | "due";
  installments: Installment[];
};

export interface TrialStore {
  find(userId: string): TrialRecord | undefined;
  create(record: TrialRecord): void;
  update(userId: string, patch: Partial<TrialRecord>): void;
  /** Users whose trial still has something to do, including suspended entries left after settlement. */
  open(): TrialRecord[];
  suspended(userId: string): SuspendedEntry[];
  markDue(userId: string, lines: SettlementLine[]): void;
  /** Adds suspended entries to settle at trial end; an id already present is ignored. */
  addSuspended(userId: string, entries: SuspendedEntry[]): void;
}

/** Holds the trial and its suspended entries until the penalty ledger has its own store. */
export class InMemoryTrialStore implements TrialStore {
  private readonly trials = new Map<string, TrialRecord>();
  private readonly ledger = new Map<string, LedgerEntry[]>();

  find(userId: string) {
    return this.trials.get(userId);
  }
  create(record: TrialRecord) {
    this.trials.set(record.userId, record);
  }
  update(userId: string, patch: Partial<TrialRecord>) {
    const row = this.trials.get(userId);
    if (row) Object.assign(row, patch);
  }
  open() {
    // A settled trial stays open while entries are still suspended (held by an appeal).
    return [...this.trials.values()].filter(
      (t) =>
        !(t.state === "settled" && t.settledPublished && this.suspended(t.userId).length === 0),
    );
  }
  suspended(userId: string) {
    return (this.ledger.get(userId) ?? []).filter((e) => e.status === "suspended");
  }
  markDue(userId: string, lines: SettlementLine[]) {
    for (const line of lines) {
      const e = (this.ledger.get(userId) ?? []).find((x) => x.id === line.entryId);
      if (e) {
        e.status = "due";
        e.installments = line.installments;
      }
    }
  }
  addSuspended(userId: string, entries: SuspendedEntry[]) {
    const list = this.ledger.get(userId) ?? [];
    for (const e of entries) {
      if (list.some((x) => x.id === e.id)) continue;
      list.push({ ...e, status: "suspended", installments: [] });
    }
    this.ledger.set(userId, list);
  }
  entries(userId: string) {
    return this.ledger.get(userId) ?? [];
  }
}

export type TrialServiceDeps = {
  store: TrialStore;
  publish?: (event: EventEnvelope) => void | Promise<void>;
  /** Reads the user's trial settings; registry defaults when unavailable. */
  readSettings?: (userId: string) => Promise<TrialSettings>;
  /**
   * Called with the settled lines before the trial ledger is updated, so the penalty ledger
   * can move its entries to `due`. Must be idempotent: a throw leaves the trial unsettled and
   * the next job run tries again.
   */
  /**
   * True while an entry must not be settled: its appeal is open or it was reversed. Held
   * entries stay suspended and are settled by a later run once released.
   */
  isHeld?: (userId: string, entryId: string) => Promise<boolean>;
  onSettled?: (userId: string, lines: SettlementLine[], now: Date) => Promise<void>;
  newId?: () => string;
  onPublishError?: (err: unknown) => void;
};

/** Every method takes `now`; nothing here reads the system clock. */
export function createTrialService(deps: TrialServiceDeps) {
  const newId = deps.newId ?? randomUUID;
  const readSettings = deps.readSettings ?? (async () => DEFAULT_TRIAL_SETTINGS);

  async function emit<T extends "trial.started" | "trial.ended" | "trial.settled">(
    userId: string,
    type: T,
    payload: EventPayload<T>,
    now: Date,
  ): Promise<boolean> {
    try {
      await deps.publish?.({
        id: newId(),
        type,
        userId,
        occurredAt: now.toISOString(),
        schemaVersion: EVENT_SCHEMA_VERSION,
        payload,
      } as EventEnvelope);
      return true;
    } catch (err) {
      deps.onPublishError?.(err);
      return false;
    }
  }

  /** Suspended entries that may be settled now (not under an open appeal, not reversed). */
  async function settleable(userId: string): Promise<SuspendedEntry[]> {
    const out: SuspendedEntry[] = [];
    for (const e of deps.store.suspended(userId)) {
      if (e.appealOpen) continue;
      if (deps.isHeld && (await deps.isHeld(userId, e.id))) continue;
      out.push(e);
    }
    return out;
  }

  /** Settles the given entries; false when the penalty ledger failed and the run must retry. */
  async function settleEntries(
    t: TrialRecord,
    entries: SuspendedEntry[],
    now: Date,
  ): Promise<SettlementLine[] | undefined> {
    const lines = settleTrial({
      entries,
      installmentsK: t.settings.installmentsK,
      settledAt: now,
      installmentIntervalMs: t.settings.installmentIntervalMs,
    });
    try {
      await deps.onSettled?.(t.userId, lines, now);
    } catch (err) {
      deps.onPublishError?.(err);
      return undefined;
    }
    deps.store.markDue(t.userId, lines);
    return lines;
  }

  async function advance(t: TrialRecord, now: Date): Promise<void> {
    const { userId } = t;
    if (!t.startedPublished) {
      const ok = await emit(
        userId,
        "trial.started",
        {
          weeks: t.settings.weeks,
          installmentsK: t.settings.installmentsK,
          endsAt: t.endsAt,
        },
        now,
      );
      if (!ok) return;
      deps.store.update(userId, { startedPublished: true });
    }
    if (t.state === "active" && now.getTime() >= Date.parse(t.endsAt)) {
      const total = (await settleable(userId)).reduce((sum, e) => sum + e.amountVnd, 0);
      deps.store.update(userId, {
        state: "final_appeal",
        endReason: "elapsed",
        suspendedTotalVnd: total,
        finalAppealEndsAt: computeFinalAppealEnd(
          new Date(t.endsAt),
          t.settings.finalAppealHours,
        ).toISOString(),
      });
    }
    if (t.state === "final_appeal" && !t.endedPublished) {
      const ok = await emit(
        userId,
        "trial.ended",
        {
          reason: t.endReason ?? "elapsed",
          suspendedTotalVnd: t.suspendedTotalVnd ?? 0,
          finalAppealEndsAt: t.finalAppealEndsAt!,
        },
        now,
      );
      if (!ok) return;
      deps.store.update(userId, { endedPublished: true });
    }
    if (
      t.state === "final_appeal" &&
      t.endedPublished &&
      now.getTime() >= Date.parse(t.finalAppealEndsAt!)
    ) {
      const entries = await settleable(userId);
      const lines = await settleEntries(t, entries, now);
      if (!lines) return;
      const byId = new Map(entries.map((e) => [e.id, e.amountVnd]));
      deps.store.update(userId, {
        state: "settled",
        settledTotalVnd: lines.reduce((s, l) => s + (byId.get(l.entryId) ?? 0), 0),
      });
    }
    if (t.state === "settled" && !t.settledPublished) {
      const ok = await emit(
        userId,
        "trial.settled",
        { totalVnd: t.settledTotalVnd ?? 0, installmentsK: t.settings.installmentsK },
        now,
      );
      if (ok) deps.store.update(userId, { settledPublished: true });
    }
    // Entries released from an appeal after settlement are settled by the same rules; the
    // trial.settled event is not repeated (it carries the total settled at the end).
    if (t.state === "settled" && t.settledPublished) {
      const late = await settleable(userId);
      if (late.length > 0) await settleEntries(t, late, now);
    }
  }

  return {
    /** Starts the user's one trial; later contracts (other cycles) do not restart it. */
    async onContractSigned(event: EventEnvelope, now: Date): Promise<{ started: boolean }> {
      const { userId } = event;
      if (deps.store.find(userId)) return { started: false };
      const settings = await readSettings(userId);
      if (deps.store.find(userId)) return { started: false };
      const record: TrialRecord = {
        userId,
        settings,
        startedAt: now.toISOString(),
        endsAt: computeTrialEnd(now, settings.weeks).toISOString(),
        state: "active",
        startedPublished: false,
        endedPublished: false,
        settledPublished: false,
      };
      deps.store.create(record);
      await advance(record, now);
      return { started: true };
    },
    /**
     * Turning the trial off (or closing the account) ends it immediately: `trial.ended` carries
     * the reason, the final appeal window opens now, and settlement follows as at a normal end.
     */
    async endEarly(
      userId: string,
      reason: Exclude<TrialEndReason, "elapsed">,
      now: Date,
    ): Promise<{ ended: boolean }> {
      const t = deps.store.find(userId);
      if (!t || t.state !== "active") return { ended: false };
      const total = (await settleable(userId)).reduce((sum, e) => sum + e.amountVnd, 0);
      deps.store.update(userId, {
        state: "final_appeal",
        endReason: reason,
        endsAt: now.toISOString(),
        suspendedTotalVnd: total,
        finalAppealEndsAt: computeFinalAppealEnd(now, t.settings.finalAppealHours).toISOString(),
      });
      await advance(t, now);
      return { ended: true };
    },
    /** The trial job: run with an injected `now` (test-kit clock in scenarios). */
    async runJob(now: Date): Promise<void> {
      for (const t of deps.store.open()) await advance(t, now);
    },
  };
}

export type TrialService = ReturnType<typeof createTrialService>;
