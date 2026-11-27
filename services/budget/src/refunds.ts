/** Pure rules for refunds and internal transfers (spec 10 section 5). Integer VND only. */

export interface RefundInput {
  /** Amount of the original outgoing transaction. */
  originalVnd: number;
  /** Amount of the original already restored by earlier refunds. */
  alreadyRestoredVnd: number;
  refundVnd: number;
}

export interface RefundSplit {
  /** Returned to the category limit, capped at the original amount. */
  restoredVnd: number;
  /** Any excess goes to the income pool, never to the running budget. */
  incomeVnd: number;
}

export function bookRefund(input: RefundInput): RefundSplit {
  const room = Math.max(0, input.originalVnd - input.alreadyRestoredVnd);
  const refund = Math.max(0, input.refundVnd);
  const restoredVnd = Math.min(refund, room);
  return { restoredVnd, incomeVnd: refund - restoredVnd };
}

export interface PairLeg {
  accountId: string;
  direction: "in" | "out";
  amountVnd: number;
  occurredAt: string;
}

/**
 * Two legs form one internal transfer when one leaves own account A and one enters own account B
 * for an equal amount within the window (`budget.internal_transfer_match_window_minutes`).
 */
export function isInternalTransferPair(
  out: PairLeg,
  inn: PairLeg,
  ownAccountIds: readonly string[],
  windowMinutes: number,
): boolean {
  if (out.direction !== "out" || inn.direction !== "in") return false;
  if (out.accountId === inn.accountId) return false;
  if (!ownAccountIds.includes(out.accountId) || !ownAccountIds.includes(inn.accountId)) {
    return false;
  }
  if (out.amountVnd !== inn.amountVnd || out.amountVnd <= 0) return false;
  const gapMs = Math.abs(Date.parse(out.occurredAt) - Date.parse(inn.occurredAt));
  return Number.isFinite(gapMs) && gapMs <= windowMinutes * 60_000;
}
