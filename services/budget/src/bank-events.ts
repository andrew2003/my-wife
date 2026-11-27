/** Pure rules for cash withdrawals and bank fees (spec 10 section 5). Integer VND only. */
import { parseInternalTransferMemo } from "./refunds";

/**
 * Short code of the system category that holds bank fees. Not a spec number: a stable lookup key
 * for a category that is created on the first fee when the user has none with this code.
 */
export const BANK_FEES_SHORT_CODE = "BF";

/** Default phrases, normalized (upper case, no diacritics, single spaces). Data, not logic. */
export const DEFAULT_CASH_PHRASES: readonly string[] = [
  "ATM",
  "RUT TIEN",
  "CASH WITHDRAWAL",
  "WITHDRAWAL",
  "CASH OUT",
];
export const DEFAULT_FEE_PHRASES: readonly string[] = [
  "PHI DICH VU",
  "PHI DUY TRI",
  "PHI QUAN LY",
  "PHI THUONG NIEN",
  "PHI SMS",
  "LAI SUAT",
  "SERVICE FEE",
  "MAINTENANCE FEE",
  "ANNUAL FEE",
  "BANK FEE",
  "INTEREST CHARGE",
  "FEE",
];

export interface BankEventReceipt {
  direction: "in" | "out";
  memo: string;
  counterparty: string | null;
}

/** Upper case, strip diacritics (including d-stroke), every other character becomes a space. */
function words(text: string): string {
  return (
    " " +
    text
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .replace(/[đĐ]/g, "D")
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, " ")
      .trim() +
    " "
  );
}

const hasPhrase = (haystack: string, phrases: readonly string[]) =>
  phrases.some((p) => haystack.includes(` ${p} `));

/**
 * Pure: an outgoing receipt whose memo or counterparty holds a whole-word cash phrase is a
 * `cash_withdrawal`; a fee or interest phrase makes it a `bank_fee`, and a fee wins over cash
 * (the fee charged for a withdrawal is a fee). An own-account transfer memo is never classified
 * here. The text is matched as data against fixed phrases, never as an instruction.
 */
export function classifyBankEvent(
  receipt: BankEventReceipt,
  phrases: { cash?: readonly string[]; fee?: readonly string[] } = {},
): "cash_withdrawal" | "bank_fee" | undefined {
  if (receipt.direction !== "out") return undefined;
  if (parseInternalTransferMemo(receipt.memo)) return undefined;
  const text = words(`${receipt.memo} ${receipt.counterparty ?? ""}`);
  if (hasPhrase(text, phrases.fee ?? DEFAULT_FEE_PHRASES)) return "bank_fee";
  if (hasPhrase(text, phrases.cash ?? DEFAULT_CASH_PHRASES)) return "cash_withdrawal";
  return undefined;
}

/** Pure: when the withdrawal must be allocated (`budget.cash_allocation_deadline_hours`). */
export function cashAllocationDeadline(occurredAt: string, deadlineHours: number): string {
  return new Date(Date.parse(occurredAt) + deadlineHours * 3_600_000).toISOString();
}

/** Pure: cash withdrawn but not yet allocated to a category. */
export function unallocatedCashVnd(
  transactions: readonly {
    transactionType: string;
    categoryId: string | null;
    amountVnd: number;
  }[],
): number {
  return transactions
    .filter((t) => t.transactionType === "cash_withdrawal" && t.categoryId === null)
    .reduce((sum, t) => sum + t.amountVnd, 0);
}
