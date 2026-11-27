import {
  ConsentListResponseSchema,
  ExportResponseSchema,
  type ConsentKind,
} from "@my-wife/contracts";
import type { z } from "zod";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export type ConsentRecord = Extract<
  z.infer<typeof ConsentListResponseSchema>,
  { ok: true }
>["data"]["consents"][number];

/** Version of the consent texts shown on this screen; identity rejects an older one (409). */
export const CONSENT_TEXT_VERSION = 1;

export type ConsentsResult = { status: "ready"; consents: ConsentRecord[] } | { status: "error" };

export async function loadConsents(doFetch: FetchLike = fetch): Promise<ConsentsResult> {
  try {
    const res = await doFetch("/api/consents", { cache: "no-store" });
    if (!res.ok) return { status: "error" };
    const parsed = ConsentListResponseSchema.safeParse(await res.json());
    if (!parsed.success || !parsed.data.ok) return { status: "error" };
    return { status: "ready", consents: parsed.data.data.consents };
  } catch {
    return { status: "error" };
  }
}

export async function grantConsent(kind: ConsentKind, doFetch: FetchLike = fetch) {
  try {
    const res = await doFetch("/api/consents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, textVersion: CONSENT_TEXT_VERSION }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function revokeConsent(kind: ConsentKind, doFetch: FetchLike = fetch) {
  try {
    const res = await doFetch(`/api/consents/${encodeURIComponent(kind)}`, { method: "DELETE" });
    return res.ok;
  } catch {
    return false;
  }
}

export type ExportResult =
  { status: "ready"; downloadUrl: string; expiresAt: string } | { status: "error" };

/** Builds the archive now; the link lives `identity.export_ttl_hours`. */
export async function requestExport(doFetch: FetchLike = fetch): Promise<ExportResult> {
  try {
    const res = await doFetch("/api/export", { method: "POST" });
    if (!res.ok) return { status: "error" };
    const parsed = ExportResponseSchema.safeParse(await res.json());
    if (!parsed.success || !parsed.data.ok) return { status: "error" };
    const { downloadUrl, expiresAt } = parsed.data.data;
    return { status: "ready", downloadUrl, expiresAt };
  } catch {
    return { status: "error" };
  }
}

export type DeletionResult =
  | { status: "done"; state: "closing" | "closed" }
  | { status: "not_confirmed" }
  | { status: "error" };

/** The typed confirmation must equal the account email; identity checks it. */
export async function requestDeletion(
  confirmation: string,
  doFetch: FetchLike = fetch,
): Promise<DeletionResult> {
  try {
    const res = await doFetch("/api/account/deletion", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation }),
    });
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      error?: unknown;
      data?: { state?: string };
    } | null;
    if (res.ok && (body?.data?.state === "closing" || body?.data?.state === "closed"))
      return { status: "done", state: body.data.state };
    if (res.status === 400 && body?.error === "identity.deletion_not_confirmed")
      return { status: "not_confirmed" };
    return { status: "error" };
  } catch {
    return { status: "error" };
  }
}
