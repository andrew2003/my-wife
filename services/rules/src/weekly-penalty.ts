import { SETTINGS } from "@my-wife/contracts";

export type PenaltyThreshold = { points: number; amountVnd: number };

/** Weekly monitoring penalty settings of one user; defaults come from the registry. */
export type WeeklyPenaltySettings = {
  thresholds: readonly PenaltyThreshold[];
  weeklyCapVnd: number;
};

export const DEFAULT_WEEKLY_PENALTY_SETTINGS: WeeklyPenaltySettings = {
  thresholds: SETTINGS["fault.thresholds"].default,
  weeklyCapVnd: SETTINGS["penalty.weekly_cap_vnd"].default,
};

export type WeeklyPenalty = {
  /** Amount of the highest threshold reached; 0 when none. */
  rawPenaltyVnd: number;
  /** Raw penalty plus carried debt, capped at the weekly cap. */
  issuedVnd: number;
  /** Excess over the cap; becomes penalty debt next week. */
  carryOutVnd: number;
};

const nonNegInt = (n: number) => Number.isInteger(n) && n >= 0;

/**
 * Pure (spec 12 section 3): the highest threshold with `points >= threshold.points` gives the
 * raw penalty; carried debt is added, the sum is capped at the weekly cap and the excess carries
 * over. `points` are recorded points only (waived and overturned are excluded by the caller).
 * Invalid numbers count as zero; an invalid cap falls back to the default.
 */
export function computeWeeklyPenalty(
  input: { points: number; carriedDebtVnd: number },
  settings: WeeklyPenaltySettings,
): WeeklyPenalty {
  const points = nonNegInt(input.points) ? input.points : 0;
  const carried = nonNegInt(input.carriedDebtVnd) ? input.carriedDebtVnd : 0;
  const cap = nonNegInt(settings.weeklyCapVnd)
    ? settings.weeklyCapVnd
    : DEFAULT_WEEKLY_PENALTY_SETTINGS.weeklyCapVnd;
  let rawPenaltyVnd = 0;
  let best = -1;
  for (const t of settings.thresholds) {
    if (nonNegInt(t.points) && nonNegInt(t.amountVnd) && points >= t.points && t.points > best) {
      best = t.points;
      rawPenaltyVnd = t.amountVnd;
    }
  }
  const total = rawPenaltyVnd + carried;
  const issuedVnd = Math.min(total, cap);
  return { rawPenaltyVnd, issuedVnd, carryOutVnd: total - issuedVnd };
}
