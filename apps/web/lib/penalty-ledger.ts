import {
  ListPenaltiesResponseSchema,
  OpenAppealResponseSchema,
  type PenaltyLedgerEntry,
} from "@my-wife/contracts";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type LedgerResult =
  { status: "ready"; penalties: PenaltyLedgerEntry[] } | { status: "empty" } | { status: "error" };

/** Reads the whole penalty ledger (suspended, due and paid) through the gateway. */
export async function loadLedger(doFetch: FetchLike = fetch): Promise<LedgerResult> {
  try {
    const res = await doFetch("/api/penalties", { cache: "no-store" });
    if (!res.ok) return { status: "error" };
    const parsed = ListPenaltiesResponseSchema.safeParse(await res.json());
    if (!parsed.success || !parsed.data.ok) return { status: "error" };
    const { penalties } = parsed.data.data;
    return penalties.length === 0 ? { status: "empty" } : { status: "ready", penalties };
  } catch {
    return { status: "error" };
  }
}

/** A paid penalty is settled; anything still open can be appealed. */
export function canAppeal(status: PenaltyLedgerEntry["status"]): boolean {
  return status !== "paid";
}

/**
 * Subject kind that fits a penalty. Rules resolves anything but a `fault` subject through
 * `penaltyId`, and a `fault` subject needs a fault id the ledger does not expose, so routine
 * penalties use the wake-photo grade and every other source uses the classification.
 */
export function appealSubjectKind(source: PenaltyLedgerEntry["source"]) {
  return source === "routine" ? ("wake_photo_grade" as const) : ("classification" as const);
}

/**
 * Opens an appeal on a penalty: the penalty id goes in both `subjectId` and `penaltyId`
 * (see docs/decisions.md). Returns true when rules accepted it.
 */
export async function submitAppeal(
  penalty: Pick<PenaltyLedgerEntry, "id" | "source">,
  reasonText: string,
  doFetch: FetchLike = fetch,
): Promise<boolean> {
  const reason = reasonText.trim();
  if (reason.length === 0) return false;
  try {
    const res = await doFetch("/api/appeals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        subjectKind: appealSubjectKind(penalty.source),
        subjectId: penalty.id,
        penaltyId: penalty.id,
        reasonText: reason,
      }),
    });
    if (!res.ok) return false;
    const parsed = OpenAppealResponseSchema.safeParse(await res.json());
    return parsed.success && parsed.data.ok;
  } catch {
    return false;
  }
}
