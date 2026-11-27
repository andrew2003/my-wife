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

export interface RefundCandidate {
  id: string;
  cycleId: string;
  categoryId: string | null;
  direction: "in" | "out";
  amountVnd: number;
  occurredAt: string;
  counterparty: string | null;
  transactionType: string;
  restoredVnd?: number;
  refundOfTransactionId?: string;
}

export interface RefundOriginal<T extends RefundCandidate = RefundCandidate> {
  original: T;
  alreadyRestoredVnd: number;
}

const normalizePayer = (value: string | null) => (value ?? "").trim().toLowerCase();

/**
 * Pure: finds the original payment an incoming receipt refunds. It is an outgoing, categorised
 * payment to the same counterparty, made no later than the refund. The most recent original
 * with room left wins; when none has room the most recent one is linked (the whole refund is
 * then income). Undefined means the receipt is not a refund.
 */
export function findRefundOriginal<T extends RefundCandidate>(
  receipt: { counterparty: string | null; occurredAt: string },
  transactions: readonly T[],
): RefundOriginal<T> | undefined {
  const payer = normalizePayer(receipt.counterparty);
  if (payer === "") return undefined;
  const at = Date.parse(receipt.occurredAt);
  const originals = transactions
    .filter(
      (t) =>
        t.direction === "out" &&
        t.categoryId !== null &&
        t.transactionType !== "refund" &&
        t.transactionType !== "internal_transfer" &&
        normalizePayer(t.counterparty) === payer &&
        Date.parse(t.occurredAt) <= at,
    )
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
  const withRestored = originals.map((original) => ({
    original,
    alreadyRestoredVnd: transactions
      .filter((t) => t.transactionType === "refund" && t.refundOfTransactionId === original.id)
      .reduce((sum, t) => sum + (t.restoredVnd ?? 0), 0),
  }));
  return (
    withRestored.find((o) => o.original.amountVnd - o.alreadyRestoredVnd > 0) ?? withRestored[0]
  );
}

/**
 * Pure: the split of a refund. An original from an earlier cycle is closed and never edited, so
 * nothing is restored to the running cycle and the whole refund is income.
 */
export function splitRefund(input: RefundInput & { sameCycle: boolean }): RefundSplit {
  if (!input.sameCycle) return { restoredVnd: 0, incomeVnd: Math.max(0, input.refundVnd) };
  return bookRefund(input);
}

/** Pure: the account codes of a `MW-DC-<from>-<to>` memo, upper case, or undefined. */
export function parseInternalTransferMemo(memo: string): { from: string; to: string } | undefined {
  const m = /\bMW-DC-([A-Za-z0-9]+)-([A-Za-z0-9]+)\b/.exec(memo);
  return m ? { from: m[1]!.toUpperCase(), to: m[2]!.toUpperCase() } : undefined;
}
