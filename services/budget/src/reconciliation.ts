import type { ReconciliationResult } from "@my-wife/contracts";

/** Tolerance settings `budget.tolerance_percent` and `budget.tolerance_min_vnd` (spec 01). */
export interface ToleranceSettings {
  percent: number;
  minVnd: number;
}

export interface PlannedTransferInput {
  plannedVnd: number;
  amountVnd: number;
  tolerance: ToleranceSettings;
  payingAccountId: string;
  /** The account that holds the category the receipt is assigned to. */
  categoryAccountId: string;
}

/** Pure: allowed difference in whole VND, the larger of the percentage and the minimum. */
export function toleranceVnd(plannedVnd: number, tolerance: ToleranceSettings): number {
  const byPercent = Math.floor((plannedVnd * tolerance.percent) / 100);
  return Math.max(byPercent, tolerance.minVnd);
}

/**
 * Pure: reconciliation result of a receipt for a planned item (spec 10 section 5).
 * Precedence: wrong_bank > amount_mismatch > matched. The tolerance bound is inclusive.
 */
export function reconcilePlannedTransfer(input: PlannedTransferInput): ReconciliationResult {
  if (input.payingAccountId !== input.categoryAccountId) return "wrong_bank";
  const diff = Math.abs(input.amountVnd - input.plannedVnd);
  return diff <= toleranceVnd(input.plannedVnd, input.tolerance) ? "matched" : "amount_mismatch";
}
