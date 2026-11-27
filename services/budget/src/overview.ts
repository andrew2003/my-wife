import { SETTINGS, type BudgetOverviewResponse, type SettingKey } from "@my-wife/contracts";
import type { SampleBudgetRecord } from "./onboarding";
import { effectiveWeeklyLimit } from "./overspend";
import { buildWeeklyLimitPlan } from "./weekly-plan";

const DAY_MS = 86_400_000;
const WEEK_DAYS = 7;
const dayStart = (day: string) => Date.parse(`${day}T00:00:00.000Z`);

type OverviewData = Extract<BudgetOverviewResponse, { ok: true }>["data"];

/** Pure: 1-based week of `at` inside the cycle, clamped to `1..weeks` (UTC days, as schedule). */
export function currentWeekIndex(firstDay: string, weeks: number, at: Date): number {
  const days = Math.floor((at.getTime() - dayStart(firstDay)) / DAY_MS);
  const index = Math.floor(days / WEEK_DAYS) + 1;
  return Math.min(Math.max(index, 1), weeks);
}

/** Pure: weekIndex of a transaction instant, same rule as `currentWeekIndex`. */
function weekOf(record: SampleBudgetRecord, occurredAt: string): number {
  return currentWeekIndex(record.cycle.firstDay, record.cycle.weeks, new Date(occurredAt));
}

/**
 * Pure: the overview of the user's cycle at `now` (ADR 0012). Limits follow the weekly plan
 * with deductions from earlier overspends; `roundingVnd` is the user's setting.
 */
export function buildOverview(
  record: SampleBudgetRecord,
  now: Date,
  roundingVnd: number,
): OverviewData {
  const { cycle } = record;
  const weekIndex = currentWeekIndex(cycle.firstDay, cycle.weeks, now);
  const start = dayStart(cycle.firstDay) + (weekIndex - 1) * WEEK_DAYS * DAY_MS;
  // The last week also takes any instant after the cycle's nominal end.
  const end = weekIndex === cycle.weeks ? Infinity : start + WEEK_DAYS * DAY_MS;
  const categories = record.categories.map((category) => {
    const base = buildWeeklyLimitPlan({
      cycleLimitVnd: category.cycleLimitVnd,
      weeks: cycle.weeks,
      roundingVnd,
    })[weekIndex - 1]!;
    const weeklyLimitVnd = effectiveWeeklyLimit(
      base,
      category.id,
      weekIndex,
      record.limitAdjustments,
    );
    const spentVnd = record.transactions
      .filter((t) => {
        const at = Date.parse(t.occurredAt);
        return (
          t.cycleId === cycle.id &&
          t.categoryId === category.id &&
          t.direction === "out" &&
          at >= start &&
          at < end
        );
      })
      .reduce((sum, t) => sum + t.amountVnd, 0);
    return { category, weeklyLimitVnd, spentVnd, remainingVnd: weeklyLimitVnd - spentVnd };
  });
  return {
    cycle,
    weekIndex,
    bankAccounts: record.accounts,
    categories,
    transactions: [...record.transactions]
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .map((t) => ({
        id: t.id,
        receiptId: t.receiptId,
        bankAccountId: t.bankAccountId,
        direction: t.direction,
        amountVnd: t.amountVnd,
        occurredAt: t.occurredAt,
        memo: t.memo,
        counterparty: t.counterparty,
        transactionType: t.transactionType,
        reconciliationResult: t.reconciliationResult,
        categoryId: t.categoryId,
        plannedItemId: null,
        cycleId: t.cycleId,
        weekIndex: weekOf(record, t.occurredAt),
        linkedTransactionId: null,
        adjustmentOf: null,
      })),
    anomalies: record.anomalies
      .filter((a) => a.state === "open")
      .map((a) => ({ id: a.id, kind: a.kind, subjectRef: `receipt:${a.receiptId}` })),
  };
}

/** The user's rounding setting, or the registry default when missing or invalid. */
export function roundingFrom(settings: Partial<Record<SettingKey, unknown>>): number {
  const v = settings["budget.weekly_limit_rounding_vnd"];
  return Number.isSafeInteger(v) && (v as number) > 0
    ? (v as number)
    : SETTINGS["budget.weekly_limit_rounding_vnd"].default;
}
