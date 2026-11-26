export interface WeeklyLimitPlanInput {
  /** Cycle limit of a variable category, integer VND. */
  cycleLimitVnd: number;
  /** Number of weeks in the cycle (setting). */
  weeks: number;
  /** Setting budget.weekly_limit_rounding_vnd; passed in, never hard-coded. */
  roundingVnd: number;
}

/**
 * Weekly limits of one category: each non-final week is the even share
 * rounded down to a multiple of `roundingVnd`; the last week takes the
 * remainder so the limits sum to the cycle limit. Pure, integer VND.
 */
export function buildWeeklyLimitPlan(input: WeeklyLimitPlanInput): number[] {
  const { cycleLimitVnd, weeks, roundingVnd } = input;
  if (!Number.isSafeInteger(cycleLimitVnd) || cycleLimitVnd < 0) {
    throw new RangeError("cycleLimitVnd must be a non-negative integer");
  }
  if (!Number.isSafeInteger(weeks) || weeks < 1) {
    throw new RangeError("weeks must be a positive integer");
  }
  if (!Number.isSafeInteger(roundingVnd) || roundingVnd < 1) {
    throw new RangeError("roundingVnd must be a positive integer");
  }
  const share = Math.floor(Math.floor(cycleLimitVnd / weeks) / roundingVnd) * roundingVnd;
  const plan = Array.from({ length: weeks - 1 }, () => share);
  plan.push(cycleLimitVnd - share * (weeks - 1));
  return plan;
}
