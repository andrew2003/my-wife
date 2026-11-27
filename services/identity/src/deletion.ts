/** A penalty that is still open. Only these three facts survive account deletion. */
export type PenaltySummary = {
  amountVnd: number;
  /** Local date the penalty was set, `YYYY-MM-DD`. */
  date: string;
  status: "suspended" | "due";
};

/** Port: `rules` owns penalties; identity never reads their storage. */
export interface PenaltyPort {
  /** Suspended or due penalties of the user; an empty list means the ledger is settled. */
  listOpen(userId: string): Promise<PenaltySummary[]>;
}

/** Placeholder email for an erased account; unique per user and not deliverable. */
export function anonymisedEmail(userId: string): string {
  return `deleted-${userId}@deleted.invalid`;
}
