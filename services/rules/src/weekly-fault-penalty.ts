import { randomUUID } from "node:crypto";
import type { EventEnvelope, EventPayload } from "@my-wife/contracts";
import type { FaultStore } from "./fault";
import type { PenaltyService } from "./penalty";
import {
  DEFAULT_WEEKLY_PENALTY_SETTINGS,
  computeWeeklyPenalty,
  type PenaltyThreshold,
  type WeeklyPenaltySettings,
} from "./weekly-penalty";

const WEEK_MS = 7 * 24 * 3_600_000;

/** The week as schedule and budget define it: seven UTC days from `firstDay`, end exclusive. */
export function weekWindow(firstDay: string): { from: Date; to: Date } {
  const from = new Date(`${firstDay}T00:00:00.000Z`);
  return { from, to: new Date(from.getTime() + WEEK_MS) };
}

/**
 * The stored result of one week for one user. It keeps every input of the computation (fault
 * ids, thresholds, cap, carried debt), so an appeal can re-run it and get the same output.
 * A week is computed once; later changes to faults never rewrite it.
 */
export type WeeklyPenaltyRecord = {
  id: string;
  weekId: string;
  firstDay: string;
  sourceEventId: string;
  computedAt: string;
  points: number;
  faultIds: string[];
  thresholds: readonly PenaltyThreshold[];
  weeklyCapVnd: number;
  carriedInVnd: number;
  rawPenaltyVnd: number;
  issuedVnd: number;
  /** Debt carried to the next week (excess over the cap). */
  carryOutVnd: number;
  /** Ledger entry of the issued penalty; null when nothing was issued. */
  penaltyId: string | null;
};

export interface WeeklyPenaltyStore {
  /** Synchronously inserts the record unless (user, weekId) exists; returns whether it did. */
  insertOnce(userId: string, record: WeeklyPenaltyRecord): boolean;
  find(userId: string, weekId: string): WeeklyPenaltyRecord | undefined;
  attachPenalty(userId: string, weekId: string, penaltyId: string): void;
  /** Debt carried out of the latest week that starts before `firstDay`; 0 when none. */
  carriedInto(userId: string, firstDay: string): number;
  list(userId: string): readonly WeeklyPenaltyRecord[];
}

export class InMemoryWeeklyPenaltyStore implements WeeklyPenaltyStore {
  private readonly rows = new Map<string, WeeklyPenaltyRecord[]>();
  insertOnce(userId: string, record: WeeklyPenaltyRecord) {
    const list = this.rows.get(userId) ?? [];
    if (list.some((r) => r.weekId === record.weekId)) return false;
    list.push(Object.freeze(record));
    this.rows.set(userId, list);
    return true;
  }
  find(userId: string, weekId: string) {
    return this.rows.get(userId)?.find((r) => r.weekId === weekId);
  }
  attachPenalty(userId: string, weekId: string, penaltyId: string) {
    const list = this.rows.get(userId) ?? [];
    const i = list.findIndex((r) => r.weekId === weekId);
    if (i >= 0) list[i] = Object.freeze({ ...list[i]!, penaltyId });
  }
  carriedInto(userId: string, firstDay: string) {
    const prior = (this.rows.get(userId) ?? [])
      .filter((r) => r.firstDay < firstDay)
      .sort((a, b) => (a.firstDay < b.firstDay ? -1 : 1));
    return prior.length === 0 ? 0 : prior[prior.length - 1]!.carryOutVnd;
  }
  list(userId: string) {
    return this.rows.get(userId) ?? [];
  }
}

export type WeeklyPenaltyResult = Pick<
  WeeklyPenaltyRecord,
  "weekId" | "points" | "carriedInVnd" | "rawPenaltyVnd" | "issuedVnd" | "carryOutVnd" | "penaltyId"
> & { duplicate: boolean };

export type WeeklyPenaltyServiceDeps = {
  faultStore: Pick<FaultStore, "list">;
  weeklyStore: WeeklyPenaltyStore;
  penalties: Pick<PenaltyService, "issueMonitoring">;
  /** Thresholds and cap in force for the user; registry defaults when absent. */
  readSettings?: (userId: string, at: Date) => Promise<WeeklyPenaltySettings>;
  newId?: () => string;
};

/** Every method takes `now`; nothing here reads the system clock. */
export function createWeeklyPenaltyService(deps: WeeklyPenaltyServiceDeps) {
  const newId = deps.newId ?? randomUUID;
  const readSettings = deps.readSettings ?? (async () => DEFAULT_WEEKLY_PENALTY_SETTINGS);

  async function issue(userId: string, record: WeeklyPenaltyRecord, now: Date) {
    if (record.issuedVnd <= 0) return;
    const out = await deps.penalties.issueMonitoring(
      userId,
      {
        sourceKey: `monitoring:${record.weekId}`,
        amountVnd: record.issuedVnd,
        transferCode: `MW-PH-MON-${record.weekId.replace(/-/g, "").slice(0, 8)}`,
        detail: {
          sourceEventId: record.sourceEventId,
          weeklyRecordId: record.id,
          weekId: record.weekId,
          firstDay: record.firstDay,
          points: record.points,
          faultIds: record.faultIds,
          carriedInVnd: record.carriedInVnd,
          rawPenaltyVnd: record.rawPenaltyVnd,
          carryOutVnd: record.carryOutVnd,
        },
      },
      now,
    );
    deps.weeklyStore.attachPenalty(userId, record.weekId, out.penaltyId);
    return out.penaltyId;
  }

  const view = (r: WeeklyPenaltyRecord, duplicate: boolean): WeeklyPenaltyResult => ({
    weekId: r.weekId,
    points: r.points,
    carriedInVnd: r.carriedInVnd,
    rawPenaltyVnd: r.rawPenaltyVnd,
    issuedVnd: r.issuedVnd,
    carryOutVnd: r.carryOutVnd,
    penaltyId: r.penaltyId,
    duplicate,
  });

  return {
    /**
     * Consumes `week.closed`: sums the `recorded` fault points of the user's week (waived,
     * appealed, overturned and pending faults do not count), computes the penalty with the
     * thresholds, the cap and the carried debt, stores the computation, and issues one
     * `monitoring` ledger entry when the amount is above zero. Once per (user, week): a
     * redelivery returns the stored result and only completes an event still owed.
     */
    async onWeekClosed(event: EventEnvelope, now: Date): Promise<WeeklyPenaltyResult> {
      const { userId } = event;
      const p = event.payload as EventPayload<"week.closed">;
      const existing = deps.weeklyStore.find(userId, p.weekId);
      if (existing) {
        await issue(userId, existing, now);
        return view(deps.weeklyStore.find(userId, p.weekId)!, true);
      }
      const settings = await readSettings(userId, now);
      const { from, to } = weekWindow(p.firstDay);
      const counted = deps.faultStore.list(userId).filter((f) => {
        const t = Date.parse(f.occurredAt);
        return f.status === "recorded" && t >= from.getTime() && t < to.getTime();
      });
      const points = counted.reduce((sum, f) => sum + f.points, 0);
      const carriedInVnd = deps.weeklyStore.carriedInto(userId, p.firstDay);
      const result = computeWeeklyPenalty({ points, carriedDebtVnd: carriedInVnd }, settings);
      const record: WeeklyPenaltyRecord = {
        id: newId(),
        weekId: p.weekId,
        firstDay: p.firstDay,
        sourceEventId: event.id,
        computedAt: now.toISOString(),
        points,
        faultIds: counted.map((f) => f.id),
        thresholds: settings.thresholds,
        weeklyCapVnd: settings.weeklyCapVnd,
        carriedInVnd,
        rawPenaltyVnd: result.rawPenaltyVnd,
        issuedVnd: result.issuedVnd,
        carryOutVnd: result.carryOutVnd,
        penaltyId: null,
      };
      const inserted = deps.weeklyStore.insertOnce(userId, record);
      const stored = deps.weeklyStore.find(userId, p.weekId)!;
      await issue(userId, stored, now);
      return view(deps.weeklyStore.find(userId, p.weekId)!, !inserted);
    },
  };
}

export type WeeklyPenaltyService = ReturnType<typeof createWeeklyPenaltyService>;
