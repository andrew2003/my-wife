import type { ReceiptState } from "@my-wife/contracts";

/**
 * Allowed receipt transitions (spec 11, section 2). `rejected`, `duplicate`, `parsed` and
 * `failed` are terminal. A mail refused for consent or size is never stored, so it has no
 * state here at all.
 */
const TRANSITIONS: Record<ReceiptState, readonly ReceiptState[]> = {
  received: ["rejected", "duplicate", "parsing", "needs_confirmation"],
  parsing: ["parsed", "needs_confirmation", "failed", "duplicate"],
  needs_confirmation: ["parsing", "parsed", "failed"],
  rejected: [],
  duplicate: [],
  parsed: [],
  failed: [],
};

export function canTransition(from: ReceiptState, to: ReceiptState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: ReceiptState, to: ReceiptState): void {
  if (!canTransition(from, to)) throw new Error(`illegal receipt transition ${from} -> ${to}`);
}
