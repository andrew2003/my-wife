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

export type TrialState = "active" | "final_appeal" | "settled";

export type TrialRecord = {
  userId: string;
  settings: TrialSettings;
  startedAt: string;
  endsAt: string;
  state: TrialState;
  finalAppealEndsAt?: string;
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
  /** Users whose trial still has something to do. */
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
    return [...this.trials.values()].filter((t) => !(t.state === "settled" && t.settledPublished));
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
      const total = deps.store.suspended(userId).reduce((sum, e) => sum + e.amountVnd, 0);
      deps.store.update(userId, {
        state: "final_appeal",
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
          reason: "elapsed",
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
      const lines = settleTrial({
        entries: deps.store.suspended(userId),
        installmentsK: t.settings.installmentsK,
        settledAt: now,
        installmentIntervalMs: t.settings.installmentIntervalMs,
      });
      const byId = new Map(deps.store.suspended(userId).map((e) => [e.id, e.amountVnd]));
      try {
        await deps.onSettled?.(userId, lines, now);
      } catch (err) {
        deps.onPublishError?.(err);
        return;
      }
      deps.store.markDue(userId, lines);
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
    /** The trial job: run with an injected `now` (test-kit clock in scenarios). */
    async runJob(now: Date): Promise<void> {
      for (const t of deps.store.open()) await advance(t, now);
    },
  };
}

export type TrialService = ReturnType<typeof createTrialService>;
