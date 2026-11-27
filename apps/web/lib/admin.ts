import {
  AuditLogEntrySchema,
  FeatureFlagSchema,
  IncidentSchema,
  InvitationSchema,
  SenderMapEntryRequestSchema,
} from "@my-wife/contracts";
import { z } from "zod";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type AdminIncident = z.infer<typeof IncidentSchema>;
export type AdminInvitation = z.infer<typeof InvitationSchema>;
export type AdminAuditEntry = z.infer<typeof AuditLogEntrySchema>;
export type SenderEntry = z.infer<typeof SenderMapEntryRequestSchema>;
export type FeatureFlag = z.infer<typeof FeatureFlagSchema>;

export interface AdminData {
  incidents: AdminIncident[];
  invitations: AdminInvitation[];
  senderMap: SenderEntry[];
  audit: AdminAuditEntry[];
}

export type AdminResult =
  { status: "ready"; data: AdminData } | { status: "forbidden" } | { status: "error" };

/**
 * Gateway routes: `/api/admin/*` is owned by identity and needs role admin.
 * The sender map is read from `/api/sender-map` (any signed-in caller).
 * The gateway has no admin read route for users or per-user flags yet, so the
 * flag form takes a user id and only writes.
 */
async function section<T extends z.ZodTypeAny>(
  doFetch: FetchLike,
  url: string,
  schema: T,
): Promise<{ forbidden: boolean; value: z.infer<T> | null }> {
  try {
    const res = await doFetch(url, { cache: "no-store" });
    if (res.status === 403) return { forbidden: true, value: null };
    if (!res.ok) return { forbidden: false, value: null };
    const parsed = schema.safeParse(await res.json());
    return { forbidden: false, value: parsed.success ? parsed.data : null };
  } catch {
    return { forbidden: false, value: null };
  }
}

const wrap = <T extends z.ZodTypeAny>(data: T) => z.object({ ok: z.literal(true), data });

export async function loadAdminData(doFetch: FetchLike = fetch): Promise<AdminResult> {
  const [incidents, invitations, senders, audit] = await Promise.all([
    section(
      doFetch,
      "/api/admin/incidents",
      wrap(z.object({ incidents: z.array(IncidentSchema) })),
    ),
    section(
      doFetch,
      "/api/admin/invitations",
      wrap(z.object({ invitations: z.array(InvitationSchema) })),
    ),
    section(
      doFetch,
      "/api/sender-map",
      wrap(z.object({ entries: z.array(SenderMapEntryRequestSchema) })),
    ),
    section(
      doFetch,
      "/api/admin/audit?limit=50",
      wrap(z.object({ entries: z.array(AuditLogEntrySchema) })),
    ),
  ]);
  if ([incidents, invitations, senders, audit].some((s) => s.forbidden)) {
    return { status: "forbidden" };
  }
  if (!incidents.value || !invitations.value || !senders.value || !audit.value) {
    return { status: "error" };
  }
  return {
    status: "ready",
    data: {
      incidents: [...incidents.value.data.incidents].sort((a, b) =>
        b.startsAt.localeCompare(a.startsAt),
      ),
      invitations: invitations.value.data.invitations,
      senderMap: senders.value.data.entries,
      audit: audit.value.data.entries,
    },
  };
}

export type AdminAction =
  | { kind: "end_incident"; id: string }
  | { kind: "cancel_incident"; id: string }
  | { kind: "revoke_invitation"; id: string }
  | { kind: "create_invitation"; email: string }
  | { kind: "set_flag"; userId: string; flag: FeatureFlag; enabled: boolean }
  | { kind: "save_sender"; entry: SenderEntry }
  | { kind: "remove_sender"; senderKey: string };

export type ActionResult = { status: "done" } | { status: "invalid" } | { status: "error" };

export interface IncidentDraft {
  startsAt: string;
  endsAt: string | null;
  scope: "all" | string[];
  reason: string;
}

const send = async (
  doFetch: FetchLike,
  method: string,
  url: string,
  body?: unknown,
): Promise<ActionResult> => {
  try {
    const res = await doFetch(url, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    return res.ok ? { status: "done" } : { status: "error" };
  } catch {
    return { status: "error" };
  }
};

/** A reason is required; the server also checks it, but an empty one never leaves the page. */
export async function declareIncident(
  draft: IncidentDraft,
  doFetch: FetchLike = fetch,
): Promise<ActionResult> {
  const reason = draft.reason.trim();
  if (!reason) return { status: "invalid" };
  return send(doFetch, "POST", "/api/admin/incidents", { ...draft, reason });
}

export async function adminAction(
  action: AdminAction,
  doFetch: FetchLike = fetch,
): Promise<ActionResult> {
  switch (action.kind) {
    case "end_incident":
      return send(doFetch, "POST", `/api/admin/incidents/${encodeURIComponent(action.id)}/end`, {});
    case "cancel_incident":
      return send(doFetch, "POST", `/api/admin/incidents/${encodeURIComponent(action.id)}/cancel`);
    case "revoke_invitation":
      return send(
        doFetch,
        "POST",
        `/api/admin/invitations/${encodeURIComponent(action.id)}/revoke`,
      );
    case "create_invitation":
      return send(doFetch, "POST", "/api/invitations", { email: action.email.trim() });
    case "set_flag":
      return send(doFetch, "PUT", "/api/admin/feature-flags", {
        userId: action.userId,
        flag: action.flag,
        enabled: action.enabled,
      });
    case "save_sender":
      return send(doFetch, "PUT", "/api/admin/sender-map", action.entry);
    case "remove_sender":
      return send(
        doFetch,
        "DELETE",
        `/api/admin/sender-map/${encodeURIComponent(action.senderKey)}`,
      );
  }
}
