import type { BankAccount, BudgetCategory, Priority } from "@my-wife/contracts";

type BankAccountKind = BankAccount["kind"];
type CategoryKind = BudgetCategory["kind"];

/** Ratios are integer basis points (1/100 of a percent) so no floating point is involved. */
export const RATIO_TOTAL_BP = 10_000;

export interface SampleCategoryTemplate {
  /** Stable key; also the locale key suffix `budget.sample.category.<key>`. */
  key: string;
  shortCode: string;
  priority: Priority;
  kind: CategoryKind;
  countsTowardSurplus: boolean;
  /** Which seeded account holds the category. */
  accountKind: BankAccountKind;
  /** Order among `want` categories; null for the rest. */
  wantOrder: number | null;
  /** Share of the total in basis points. */
  ratioBp: number;
}

/**
 * Standard category set with sample ratios (spec 01-budget-details, sample category set).
 * The ratios are defaults only; callers may pass another template.
 */
export const DEFAULT_SAMPLE_TEMPLATE: readonly SampleCategoryTemplate[] = [
  {
    key: "food",
    shortCode: "AN",
    priority: "need",
    kind: "variable",
    countsTowardSurplus: true,
    accountKind: "spending",
    wantOrder: null,
    ratioBp: 2700,
  },
  {
    key: "fixed_bills",
    shortCode: "HD",
    priority: "need",
    kind: "fixed",
    countsTowardSurplus: false,
    accountKind: "spending",
    wantOrder: null,
    ratioBp: 2000,
  },
  {
    key: "transport",
    shortCode: "DL",
    priority: "need",
    kind: "variable",
    countsTowardSurplus: true,
    accountKind: "spending",
    wantOrder: null,
    ratioBp: 600,
  },
  {
    key: "health_personal",
    shortCode: "YT",
    priority: "should",
    kind: "variable",
    countsTowardSurplus: true,
    accountKind: "spending",
    wantOrder: null,
    ratioBp: 500,
  },
  {
    key: "eating_out",
    shortCode: "AG",
    priority: "want",
    kind: "variable",
    countsTowardSurplus: true,
    accountKind: "spending",
    wantOrder: 1,
    ratioBp: 600,
  },
  {
    key: "entertainment",
    shortCode: "GT",
    priority: "want",
    kind: "variable",
    countsTowardSurplus: true,
    accountKind: "spending",
    wantOrder: 2,
    ratioBp: 400,
  },
  {
    key: "small_shopping",
    shortCode: "MS",
    priority: "want",
    kind: "variable",
    countsTowardSurplus: true,
    accountKind: "spending",
    wantOrder: 3,
    ratioBp: 400,
  },
  {
    key: "contingency",
    shortCode: "DP",
    priority: "fund",
    kind: "variable",
    countsTowardSurplus: false,
    accountKind: "spending",
    wantOrder: null,
    ratioBp: 500,
  },
  {
    key: "savings",
    shortCode: "TK",
    priority: "fund",
    kind: "variable",
    countsTowardSurplus: false,
    accountKind: "savings",
    wantOrder: null,
    ratioBp: 1500,
  },
  {
    key: "future_purchases",
    shortCode: "TL",
    priority: "fund",
    kind: "variable",
    countsTowardSurplus: false,
    accountKind: "savings",
    wantOrder: null,
    ratioBp: 800,
  },
  {
    key: "penalties",
    shortCode: "PT",
    priority: "fund",
    kind: "variable",
    countsTowardSurplus: false,
    accountKind: "penalty_savings",
    wantOrder: null,
    ratioBp: 0,
  },
];

/**
 * Splits `totalVnd` by `ratiosBp` in multiples of `unitVnd` (largest-remainder method).
 * Any part of the total below one unit goes to the largest ratio, so the parts sum to the
 * total exactly. Ties go to the earlier entry. Pure, integer VND.
 */
export function allocateByRatio(
  totalVnd: number,
  ratiosBp: readonly number[],
  unitVnd: number,
): number[] {
  if (!Number.isSafeInteger(totalVnd) || totalVnd < 0) {
    throw new RangeError("totalVnd must be a non-negative integer");
  }
  if (!Number.isSafeInteger(unitVnd) || unitVnd < 1) {
    throw new RangeError("unitVnd must be a positive integer");
  }
  if (ratiosBp.some((r) => !Number.isSafeInteger(r) || r < 0)) {
    throw new RangeError("ratios must be non-negative integers");
  }
  if (ratiosBp.reduce((a, b) => a + b, 0) !== RATIO_TOTAL_BP) {
    throw new RangeError(`ratios must sum to ${RATIO_TOTAL_BP} basis points`);
  }
  const units = Math.floor(totalVnd / unitVnd);
  const leftoverVnd = totalVnd - units * unitVnd;
  const shares = ratiosBp.map((r) => Math.floor((units * r) / RATIO_TOTAL_BP));
  const remainders = ratiosBp.map((r, i) => ({ i, rem: (units * r) % RATIO_TOTAL_BP, r }));
  let toHandOut = units - shares.reduce((a, b) => a + b, 0);
  const byRemainder = [...remainders].sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const { i, r } of byRemainder) {
    if (toHandOut === 0) break;
    if (r === 0) continue;
    shares[i] = (shares[i] ?? 0) + 1;
    toHandOut -= 1;
  }
  const result = shares.map((s) => s * unitVnd);
  let largestIndex = 0;
  ratiosBp.forEach((r, i) => {
    if (r > (ratiosBp[largestIndex] ?? 0)) largestIndex = i;
  });
  result[largestIndex] = (result[largestIndex] ?? 0) + leftoverVnd;
  return result;
}

export interface SampleBudgetInput {
  totalVnd: number;
  /** Setting budget.weekly_limit_rounding_vnd; limits are multiples of it where possible. */
  roundingVnd: number;
  template?: readonly SampleCategoryTemplate[];
}

export interface SampleCategoryDraft extends SampleCategoryTemplate {
  cycleLimitVnd: number;
}

export interface SampleBudgetDraft {
  totalVnd: number;
  categories: SampleCategoryDraft[];
}

/** Pure: the standard category set split by the sample ratios; limits sum to the total. */
export function buildSampleBudget(input: SampleBudgetInput): SampleBudgetDraft {
  const template = input.template ?? DEFAULT_SAMPLE_TEMPLATE;
  const limits = allocateByRatio(
    input.totalVnd,
    template.map((c) => c.ratioBp),
    input.roundingVnd,
  );
  return {
    totalVnd: input.totalVnd,
    categories: template.map((c, i) => ({ ...c, cycleLimitVnd: limits[i] ?? 0 })),
  };
}
