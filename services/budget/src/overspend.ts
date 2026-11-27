import {
  SETTINGS,
  type BudgetCategory,
  type EventEnvelope,
  type SettingKey,
} from "@my-wife/contracts";
import type { SampleBudgetRecord, SampleBudgetStore } from "./onboarding";
import { buildWeeklyLimitPlan } from "./weekly-plan";
import { writeOffOverdueReceivables } from "./debts";

/** An overspend found when a week closed (spec 10 section 8). Integer VND. */
export interface OverspendRecord {
  id: string;
  cycleId: string;
  weekIndex: number;
  categoryId: string;
  priority: BudgetCategory["priority"];
  weeklyLimitVnd: number;
  spentVnd: number;
  excessVnd: number;
  /** False until `overspend.detected` was published, so a failed publish is retried. */
  announced: boolean;
}

/** A deduction from the weekly limit of a category in a later week. */
export interface LimitAdjustment {
  categoryId: string;
  weekIndex: number;
  deductionVnd: number;
}

/** Overspend of the last week of a cycle, kept as penalty debt (no next week to deduct from). */
export interface PenaltyDebt {
  cycleId: string;
  categoryId: string;
  amountVnd: number;
}

export interface WeekCloseOutcome {
  overspends: OverspendRecord[];
  adjustments: LimitAdjustment[];
  debts: PenaltyDebt[];
}

export type NeedOverspendMode = "penalize" | "warn_only";

export interface WeeklyCategoryRow {
  categoryId: string;
  priority: BudgetCategory["priority"];
  kind: BudgetCategory["kind"];
  weeklyLimitVnd: number;
  spentVnd: number;
}

export interface OverspendFinding extends WeeklyCategoryRow {
  excessVnd: number;
  /** Amount taken from the limit of the same category later; 0 when only a warning applies. */
  deductionVnd: number;
}

/**
 * Pure: `excess = max(0, spent - weekly_limit)` per variable category that is not a `fund`
 * (spec 10 section 8). A `need` overspend with `warn_only` is reported but not deducted. The
 * penalty amount itself is decided by `rules`; `budget` only reports the facts and moves the limit.
 */
export function detectOverspends(
  rows: readonly WeeklyCategoryRow[],
  needMode: NeedOverspendMode,
): OverspendFinding[] {
  const findings: OverspendFinding[] = [];
  for (const row of rows) {
    if (row.kind !== "variable" || row.priority === "fund") continue;
    const excessVnd = Math.max(0, row.spentVnd - row.weeklyLimitVnd);
    if (excessVnd === 0) continue;
    const warnOnly = row.priority === "need" && needMode === "warn_only";
    findings.push({ ...row, excessVnd, deductionVnd: warnOnly ? 0 : excessVnd });
  }
  return findings;
}

/** Pure: the weekly limit after the deductions caused by earlier overspends; never below 0. */
export function effectiveWeeklyLimit(
  baseLimitVnd: number,
  categoryId: string,
  weekIndex: number,
  adjustments: readonly LimitAdjustment[],
): number {
  const deducted = adjustments
    .filter((a) => a.categoryId === categoryId && a.weekIndex === weekIndex)
    .reduce((sum, a) => sum + a.deductionVnd, 0);
  return Math.max(0, baseLimitVnd - deducted);
}

const DAY_MS = 86_400_000;
const WEEK_DAYS = 7;

const dayStart = (day: string) => Date.parse(`${day}T00:00:00.000Z`);

/** Week index (1-based) of a week starting on `firstDay` inside the cycle, or undefined. */
export function weekIndexOf(cycleFirstDay: string, firstDay: string): number | undefined {
  const days = Math.round((dayStart(firstDay) - dayStart(cycleFirstDay)) / DAY_MS);
  if (!Number.isFinite(days) || days < 0 || days % WEEK_DAYS !== 0) return undefined;
  return days / WEEK_DAYS + 1;
}

export interface WeekClosedDeps {
  store: SampleBudgetStore;
  now: () => Date;
  publish: (event: EventEnvelope) => void | Promise<void>;
  /** Reads the user's settings (identity); missing or invalid keys fall back to registry defaults. */
  readSettings?: (userId: string) => Promise<Partial<Record<SettingKey, unknown>>>;
  /** Ids for the transactions of written-off debts; defaults to random UUIDs. */
  newId?: () => string;
}

/**
 * Handles `week.closed` from schedule (spec 10 section 8). For each category, spending of the
 * closed week (UTC days, as schedule defines the week) is compared with the effective weekly
 * limit. The result, the deductions and an audit record are stored atomically once per
 * (cycle, week); a second delivery detects nothing. `overspend.detected` has the deterministic
 * id `overspend-<cycleId>-<weekIndex>-<categoryId>`; a failed publish is retried by the next
 * delivery, never by detecting twice. Time is a parameter: nothing here reads the clock.
 */
export function createWeekClosedHandler(deps: WeekClosedDeps) {
  const announce = async (userId: string, cycleId: string, weekIndex: number, at: Date) => {
    const owed = await deps.store.claimOverspends(userId, cycleId, weekIndex);
    try {
      for (const o of owed) {
        await deps.publish({
          id: `overspend-${cycleId}-${weekIndex}-${o.categoryId}`,
          type: "overspend.detected",
          occurredAt: at.toISOString(),
          userId,
          schemaVersion: 1,
          payload: {
            cycleId,
            weekIndex,
            categoryId: o.categoryId,
            priority: o.priority,
            weeklyLimitVnd: o.weeklyLimitVnd,
            spentVnd: o.spentVnd,
            excessVnd: o.excessVnd,
          },
        } as EventEnvelope);
        await deps.store.markOverspendAnnounced(userId, o.id);
      }
    } catch (err) {
      await deps.store.releaseOverspendClaims(userId, cycleId, weekIndex);
      throw err;
    }
  };

  const compute = (
    record: SampleBudgetRecord,
    weekIndex: number,
    firstDay: string,
    roundingVnd: number,
    needMode: NeedOverspendMode,
    newId: (categoryId: string) => string,
  ): WeekCloseOutcome => {
    const start = dayStart(firstDay);
    const end = start + WEEK_DAYS * DAY_MS;
    const rows: WeeklyCategoryRow[] = record.categories.map((c) => {
      const base = buildWeeklyLimitPlan({
        cycleLimitVnd: c.cycleLimitVnd,
        weeks: record.cycle.weeks,
        roundingVnd,
      })[weekIndex - 1]!;
      const spentVnd = record.transactions
        .filter((t) => {
          const at = Date.parse(t.occurredAt);
          return (
            t.cycleId === record.cycle.id &&
            t.categoryId === c.id &&
            t.direction === "out" &&
            at >= start &&
            at < end
          );
        })
        .reduce((sum, t) => sum + t.amountVnd, 0);
      return {
        categoryId: c.id,
        priority: c.priority,
        kind: c.kind,
        weeklyLimitVnd: effectiveWeeklyLimit(base, c.id, weekIndex, record.limitAdjustments),
        spentVnd,
      };
    });
    const found = detectOverspends(rows, needMode);
    const isLastWeek = weekIndex >= record.cycle.weeks;
    return {
      overspends: found.map((f) => ({
        id: newId(f.categoryId),
        cycleId: record.cycle.id,
        weekIndex,
        categoryId: f.categoryId,
        priority: f.priority,
        weeklyLimitVnd: f.weeklyLimitVnd,
        spentVnd: f.spentVnd,
        excessVnd: f.excessVnd,
        announced: false,
      })),
      adjustments: found
        .filter((f) => f.deductionVnd > 0 && !isLastWeek)
        .map((f) => ({
          categoryId: f.categoryId,
          weekIndex: weekIndex + 1,
          deductionVnd: f.deductionVnd,
        })),
      debts: found
        .filter((f) => f.deductionVnd > 0 && isLastWeek)
        .map((f) => ({
          cycleId: record.cycle.id,
          categoryId: f.categoryId,
          amountVnd: f.deductionVnd,
        })),
    };
  };

  const newId = deps.newId ?? (() => globalThis.crypto.randomUUID());

  return async function onWeekClosed(event: EventEnvelope): Promise<void> {
    if (event.type !== "week.closed") return;
    const { payload } = event as EventEnvelope<"week.closed">;
    const record = await deps.store.find(event.userId);
    if (!record || record.cycle.state !== "running") return;

    const weekIndex =
      payload.weekIndexInCycle ?? weekIndexOf(record.cycle.firstDay, payload.firstDay);
    if (weekIndex === undefined || weekIndex < 1 || weekIndex > record.cycle.weeks) return;
    const cycleId = record.cycle.id;

    const settings = (await deps.readSettings?.(event.userId)) ?? {};
    // Overdue receivables become expenses before the week is compared with its limits (spec 10
    // section 6); booked at the end of the closing week so they count in it.
    await writeOffOverdueReceivables(
      { store: deps.store, now: deps.now, newId, publish: deps.publish, settings },
      event.userId,
      deps.now(),
      new Date(dayStart(payload.firstDay) + WEEK_DAYS * DAY_MS - 1),
    );
    const fresh = (await deps.store.find(event.userId)) ?? record;
    const rounding = settings["budget.weekly_limit_rounding_vnd"];
    const mode = settings["penalty.need_overspend_mode"];
    const outcome = compute(
      fresh,
      weekIndex,
      payload.firstDay,
      Number.isSafeInteger(rounding) && (rounding as number) > 0
        ? (rounding as number)
        : SETTINGS["budget.weekly_limit_rounding_vnd"].default,
      mode === "warn_only" || mode === "penalize"
        ? mode
        : SETTINGS["penalty.need_overspend_mode"].default,
      (categoryId) => `os-${cycleId}-${weekIndex}-${categoryId}`,
    );

    const at = deps.now();
    const result = await deps.store.closeWeek(event.userId, cycleId, weekIndex, outcome, at);
    if (result === "not_running") return;
    // Also on `duplicate`: a first delivery whose publish failed leaves events owed.
    await announce(event.userId, cycleId, weekIndex, at);
  };
}
