import {
  ListFaultsResponseSchema,
  OpenAppealResponseSchema,
  type FaultEntry,
} from "@my-wife/contracts";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type FaultsResult =
  { status: "ready"; faults: FaultEntry[] } | { status: "empty" } | { status: "error" };

/** Reads the fault ledger through the gateway, newest first. */
export async function loadFaults(doFetch: FetchLike = fetch): Promise<FaultsResult> {
  try {
    const res = await doFetch("/api/faults", { cache: "no-store" });
    if (!res.ok) return { status: "error" };
    const parsed = ListFaultsResponseSchema.safeParse(await res.json());
    if (!parsed.success || !parsed.data.ok) return { status: "error" };
    const faults = [...parsed.data.data.faults].sort((a, b) =>
      b.occurredAt.localeCompare(a.occurredAt),
    );
    return faults.length === 0 ? { status: "empty" } : { status: "ready", faults };
  } catch {
    return { status: "error" };
  }
}

/** Only a recorded fault can be appealed (spec 12 section 2 state machine). */
export function canAppealFault(status: FaultEntry["status"]): boolean {
  return status === "recorded";
}

/** Locale key describing the reason state of a fault. */
export function reasonKey(fault: Pick<FaultEntry, "status" | "reasonRef">): string {
  if (fault.status === "pending_reason") return "fault.reason.pending";
  return fault.reasonRef ? "fault.reason.given" : "fault.reason.none";
}

/** Opens an appeal on one fault. Returns true when rules accepted it. */
export async function submitFaultAppeal(
  faultId: string,
  reasonText: string,
  doFetch: FetchLike = fetch,
): Promise<boolean> {
  const reason = reasonText.trim();
  if (reason.length === 0) return false;
  try {
    const res = await doFetch("/api/appeals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subjectKind: "fault", subjectId: faultId, reasonText: reason }),
    });
    if (!res.ok) return false;
    const parsed = OpenAppealResponseSchema.safeParse(await res.json());
    return parsed.success && parsed.data.ok;
  } catch {
    return false;
  }
}
