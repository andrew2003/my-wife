import {
  ConfirmTemplateRequestSchema,
  ReceiptParsedPayloadSchema,
  ReceiptStateSchema,
  okOrError,
  type AnomalyView,
  type ReceiptParsedPayload,
  type ReceiptState,
} from "@my-wife/contracts";
import { z } from "zod";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** `GET /ingest/receipts/:id`: the receipt state with its normalized fields. */
const ReceiptViewResponseSchema = okOrError(
  z.object({ state: ReceiptStateSchema, receipt: ReceiptParsedPayloadSchema }),
);

export type ReceiptResult =
  | { status: "ready"; state: ReceiptState; receipt: ReceiptParsedPayload }
  | { status: "empty" }
  | { status: "error" };

/** Anomaly kinds whose subject is a receipt the user can open. */
const RECEIPT_ANOMALY_KINDS: ReadonlySet<AnomalyView["kind"]> = new Set([
  "needs_confirmation",
  "unknown_receipt",
  "receipt_failed",
]);

/**
 * Link to the confirmation screen, or null when the anomaly has no receipt to open. Budget writes
 * `receipt:<id>` as the subject of receipt anomalies; a bare id is accepted for needs_confirmation.
 */
export function anomalyHref(anomaly: Pick<AnomalyView, "kind" | "subjectRef">): string | null {
  if (!RECEIPT_ANOMALY_KINDS.has(anomaly.kind)) return null;
  const prefix = "receipt:";
  const { subjectRef } = anomaly;
  const id = subjectRef.startsWith(prefix) ? subjectRef.slice(prefix.length) : subjectRef;
  const bare = !subjectRef.startsWith(prefix);
  if (id.length === 0 || (bare && anomaly.kind !== "needs_confirmation")) return null;
  return `/receipts/${encodeURIComponent(id)}`;
}

/** Only a receipt that waits for the user can be confirmed or rejected. */
export function isAwaitingConfirmation(state: ReceiptState): boolean {
  return state === "needs_confirmation";
}

/** Reads one receipt through the gateway; an unknown id counts as empty. */
export async function loadReceipt(
  receiptId: string,
  doFetch: FetchLike = fetch,
): Promise<ReceiptResult> {
  try {
    const res = await doFetch(`/api/ingest/receipts/${encodeURIComponent(receiptId)}`, {
      cache: "no-store",
    });
    if (res.status === 404) return { status: "empty" };
    if (!res.ok) return { status: "error" };
    const parsed = ReceiptViewResponseSchema.safeParse(await res.json());
    if (!parsed.success || !parsed.data.ok) return { status: "error" };
    return { status: "ready", ...parsed.data.data };
  } catch {
    return { status: "error" };
  }
}

/** Confirms (accept) or rejects a first read of a new template. True when ingest accepted it. */
export async function confirmReceipt(
  receiptId: string,
  accept: boolean,
  doFetch: FetchLike = fetch,
): Promise<boolean> {
  try {
    const res = await doFetch(
      `/api/ingest/receipts/${encodeURIComponent(receiptId)}/confirm-template`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ConfirmTemplateRequestSchema.parse({ receiptId, accept })),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}
