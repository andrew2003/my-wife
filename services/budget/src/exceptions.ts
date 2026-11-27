import { SETTINGS, type EventEnvelope, type SettingKey } from "@my-wife/contracts";
import type { SampleBudgetRecord, SampleBudgetStore } from "./onboarding";
import type { OverspendFinding } from "./overspend";

/**
 * Short code of the contingency fund category in the sample budget. The fund is found by this
 * code because categories carry no other stable key (decisions.md, MW-064).
 */
export const CONTINGENCY_SHORT_CODE = "DP";

const DAY_MS = 86_400_000;
const WEEK_DAYS = 7;

/** An exception the user claimed for one category and week, before the week closed. */
export interface ExceptionClaim {
  id: string;
  cycleId: string;
  weekIndex: number;
  categoryId: string;
  claimedAt: string;
  /** `claimed` until the week closes; then `applied` (maybe funding 0) or `released` (no excess). */
  state: "claimed" | "applied" | "released";
  /** VND debited from the contingency fund when applied; 0 otherwise. */
  fundedVnd: number;
  /** False until `exception.used` was published, so a failed publish is retried. */
  announced: boolean;
}

/** An exception applied at week close (a claimed category that had an excess). */
export interface AppliedException {
  categoryId: string;
  fundedVnd: number;
}

export interface ExceptionOutcome {
  /** Findings that remain overspends after funding (excess reduced by the funded part). */
  findings: OverspendFinding[];
  funded: AppliedException[];
}

/** Pure: the contingency balance, never below zero (spec 10 section 8). */
export function contingencyBalanceVnd(input: {
  limitVnd: number;
  spentVnd: number;
  fundedVnd: number;
}): number {
  return Math.max(0, input.limitVnd - input.spentVnd - input.fundedVnd);
}

/**
 * Pure: funds the excess of claimed categories from the contingency balance, in the order of
 * `findings`. The funded part is not penalized; what the balance cannot cover stays an overspend.
 * The balance never goes below zero.
 */
export function applyExceptions(
  findings: readonly OverspendFinding[],
  claimedCategoryIds: ReadonlySet<string>,
  balanceVnd: number,
): ExceptionOutcome {
  let balance = Math.max(0, balanceVnd);
  const remaining: OverspendFinding[] = [];
  const funded: AppliedException[] = [];
  for (const f of findings) {
    if (!claimedCategoryIds.has(f.categoryId)) {
      remaining.push(f);
      continue;
    }
    const fundedVnd = Math.min(f.excessVnd, balance);
    balance -= fundedVnd;
    funded.push({ categoryId: f.categoryId, fundedVnd });
    const left = f.excessVnd - fundedVnd;
    if (left > 0) {
      remaining.push({ ...f, excessVnd: left, deductionVnd: Math.min(f.deductionVnd, left) });
    }
  }
  return { findings: remaining, funded };
}

/** Contingency balance of the cycle in the record: limit minus spending minus exceptions. */
export function contingencyBalanceOf(record: SampleBudgetRecord): number {
  const fund = record.categories.find((c) => c.shortCode === CONTINGENCY_SHORT_CODE);
  if (!fund) return 0;
  const spentVnd = record.transactions
    .filter((t) => t.cycleId === record.cycle.id && t.categoryId === fund.id)
    .reduce((sum, t) => sum + (t.direction === "out" ? t.amountVnd : -t.amountVnd), 0);
  const fundedVnd = record.exceptionClaims
    .filter((c) => c.cycleId === record.cycle.id && c.state === "applied")
    .reduce((sum, c) => sum + c.fundedVnd, 0);
  return contingencyBalanceVnd({ limitVnd: fund.cycleLimitVnd, spentVnd, fundedVnd });
}

type ClaimErrorCode =
  | "budget.cycle_not_found"
  | "budget.cycle_not_running"
  | "budget.category_not_found"
  | "budget.exception_not_allowed"
  | "budget.week_not_open"
  | "budget.exception_already_claimed"
  | "budget.exception_limit_reached";

export type ClaimExceptionResult =
  | { ok: true; data: { claimId: string; remainingExceptions: number } }
  | { ok: false; error: { code: ClaimErrorCode } };

export interface ExceptionClaimerDeps {
  store: SampleBudgetStore;
  now: () => Date;
  newId: () => string;
  readSettings?: (userId: string) => Promise<Partial<Record<SettingKey, unknown>>>;
}

/** The 1-based week of the cycle containing `at` (UTC days, as schedule defines weeks). */
function currentWeekIndex(cycleFirstDay: string, at: Date): number {
  const today = Date.parse(`${at.toISOString().slice(0, 10)}T00:00:00Z`);
  const days = Math.floor((today - Date.parse(`${cycleFirstDay}T00:00:00Z`)) / DAY_MS);
  return days < 0 ? 0 : Math.floor(days / WEEK_DAYS) + 1;
}

/**
 * Claims an exception for a category in a week that has not closed. The quota is
 * `budget.exceptions_per_cycle` (user setting). The claim is recorded atomically with an audit
 * record; nothing is debited until the week closes.
 */
export function createExceptionClaimer(deps: ExceptionClaimerDeps) {
  return async function claimException(
    userId: string,
    input: { categoryId: string; weekIndex?: number },
  ): Promise<ClaimExceptionResult> {
    const fail = (code: ClaimErrorCode): ClaimExceptionResult => ({ ok: false, error: { code } });
    const record = await deps.store.find(userId);
    if (!record) return fail("budget.cycle_not_found");
    if (record.cycle.state !== "running") return fail("budget.cycle_not_running");
    const category = record.categories.find((c) => c.id === input.categoryId);
    if (!category) return fail("budget.category_not_found");
    if (category.kind !== "variable" || category.priority === "fund") {
      return fail("budget.exception_not_allowed");
    }
    const at = deps.now();
    const weekIndex = input.weekIndex ?? currentWeekIndex(record.cycle.firstDay, at);
    if (!Number.isInteger(weekIndex) || weekIndex < 1 || weekIndex > record.cycle.weeks) {
      return fail("budget.week_not_open");
    }
    const configured = (await deps.readSettings?.(userId))?.["budget.exceptions_per_cycle"];
    const quota =
      typeof configured === "number" && Number.isSafeInteger(configured) && configured >= 0
        ? configured
        : SETTINGS["budget.exceptions_per_cycle"].default;
    const claimId = deps.newId();
    const result = await deps.store.claimException(
      userId,
      {
        id: claimId,
        cycleId: record.cycle.id,
        weekIndex,
        categoryId: category.id,
        claimedAt: at.toISOString(),
        state: "claimed",
        fundedVnd: 0,
        announced: false,
      },
      quota,
      at,
    );
    if (result.result === "claimed") {
      return { ok: true, data: { claimId, remainingExceptions: result.remaining } };
    }
    const codes = {
      not_running: "budget.cycle_not_running",
      week_closed: "budget.week_not_open",
      duplicate: "budget.exception_already_claimed",
      limit_reached: "budget.exception_limit_reached",
    } as const;
    return fail(codes[result.result]);
  };
}

export function exceptionUsedEvent(userId: string, claim: ExceptionClaim, at: Date): EventEnvelope {
  return {
    id: `exception-${claim.cycleId}-${claim.weekIndex}-${claim.categoryId}`,
    type: "exception.used",
    occurredAt: at.toISOString(),
    userId,
    schemaVersion: 1,
    payload: {
      cycleId: claim.cycleId,
      weekIndex: claim.weekIndex,
      categoryId: claim.categoryId,
      excessVnd: claim.fundedVnd,
    },
  } as EventEnvelope;
}
