import { SETTINGS } from "@my-wife/contracts";

/** A `want` category with the part of this week's limit that is still unspent. */
export type WantLimit = { categoryId: string; remainingLimitVnd: number };

export type SourceDeduction = { categoryId: string; amountVnd: number };

export type SourceAllocation = {
  deductions: SourceDeduction[];
  /** Part of the penalty the want list could not cover; it becomes penalty debt. */
  shortfallVnd: number;
};

const posInt = (n: number) => Number.isInteger(n) && n > 0;

/**
 * Pure (spec 12 section 3 step 4): deducts the penalty from `want` categories, never `need`
 * (the caller passes only `want` categories). `order` is `penalty.want_deduction_order`: when
 * it is empty the list order is used; otherwise only the listed categories that exist in the
 * list are used, in that order. Whatever the sources cannot cover is the shortfall.
 */
export function allocatePenaltySource(input: {
  penaltyVnd: number;
  wants: readonly WantLimit[];
  order: readonly string[];
}): SourceAllocation {
  let left = posInt(input.penaltyVnd) ? input.penaltyVnd : 0;
  const byId = new Map<string, WantLimit>();
  for (const w of input.wants) if (!byId.has(w.categoryId)) byId.set(w.categoryId, w);
  const sequence =
    input.order.length === 0
      ? [...byId.values()]
      : input.order.flatMap((id) => {
          const w = byId.get(id);
          return w ? [w] : [];
        });
  const deductions: SourceDeduction[] = [];
  for (const w of sequence) {
    if (left === 0) break;
    if (!posInt(w.remainingLimitVnd)) continue;
    const amountVnd = Math.min(left, w.remainingLimitVnd);
    deductions.push({ categoryId: w.categoryId, amountVnd });
    left -= amountVnd;
  }
  return { deductions, shortfallVnd: left };
}

export type WithdrawalSettings = { extraPercent: number };

export const DEFAULT_WITHDRAWAL_SETTINGS: WithdrawalSettings = {
  extraPercent: SETTINGS["penalty.withdrawal_extra_percent"].default,
};

export type WithdrawalPenalty = { repaymentVnd: number; extraVnd: number; totalVnd: number };

/**
 * Pure (spec 12 section 4): the user repays the withdrawn amount and pays
 * `penalty.withdrawal_extra_percent` of it extra, integer VND, rounded half up.
 */
export function computeWithdrawalPenalty(
  withdrawnVnd: number,
  settings: WithdrawalSettings,
): WithdrawalPenalty {
  const repaymentVnd = posInt(withdrawnVnd) ? withdrawnVnd : 0;
  const percent =
    Number.isInteger(settings.extraPercent) &&
    settings.extraPercent >= 0 &&
    settings.extraPercent <= 100
      ? settings.extraPercent
      : DEFAULT_WITHDRAWAL_SETTINGS.extraPercent;
  const extraVnd = Math.floor((repaymentVnd * percent + 50) / 100);
  return { repaymentVnd, extraVnd, totalVnd: repaymentVnd + extraVnd };
}

/** One penalty issuance as seen by the debt carry-over. */
export type PenaltyDebtRecord = {
  id: string;
  penaltyId: string;
  at: string;
  /** Debt carried in from earlier issuances, added to the penalty before allocating. */
  carriedInVnd: number;
  penaltyVnd: number;
  deductions: SourceDeduction[];
  /** Debt carried out; the balance after this record. */
  shortfallVnd: number;
};

export interface PenaltyDebtStore {
  /** Inserts once per penalty; returns false when the penalty already has a record. */
  insertOnce(userId: string, record: PenaltyDebtRecord): boolean;
  find(userId: string, penaltyId: string): PenaltyDebtRecord | undefined;
  list(userId: string): readonly PenaltyDebtRecord[];
  /** Penalty debt carried over now: the shortfall of the latest record, 0 when none. */
  balance(userId: string): number;
}

export class InMemoryPenaltyDebtStore implements PenaltyDebtStore {
  private readonly rows = new Map<string, PenaltyDebtRecord[]>();
  insertOnce(userId: string, record: PenaltyDebtRecord) {
    const list = this.rows.get(userId) ?? [];
    if (list.some((r) => r.penaltyId === record.penaltyId)) return false;
    list.push(Object.freeze(record));
    this.rows.set(userId, list);
    return true;
  }
  find(userId: string, penaltyId: string) {
    return this.rows.get(userId)?.find((r) => r.penaltyId === penaltyId);
  }
  list(userId: string) {
    return this.rows.get(userId) ?? [];
  }
  balance(userId: string) {
    const list = this.rows.get(userId) ?? [];
    return list.length === 0 ? 0 : list[list.length - 1]!.shortfallVnd;
  }
}
