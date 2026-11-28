import type { AuditEntry } from "./incidents";

export const REDACTED = "[redacted]";

/** Keys whose values are personal or chat content; never shown on an admin screen. */
const PERSONAL_KEYS = new Set(
  [
    "email",
    "name",
    "displayName",
    "phone",
    "text",
    "message",
    "content",
    "body",
    "note",
    "comment",
    "token",
    "chatId",
    "username",
  ].map((k) => k.toLowerCase()),
);

/** Keys that hold a platform-wide address (the DKIM sender map), not a person's. */
const PLATFORM_KEYS = new Set(["senderaddress"]);

const EMAIL_RE = /[^\s@<>()"',;]+@[^\s@<>()"',;]+\.[^\s@<>()"',;]+/g;

function redactValue(value: unknown, key?: string): unknown {
  const k = key?.toLowerCase();
  if (k && PERSONAL_KEYS.has(k)) return value === null || value === undefined ? value : REDACTED;
  if (typeof value === "string") {
    return k && PLATFORM_KEYS.has(k) ? value : value.replace(EMAIL_RE, REDACTED);
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(v));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k2, v]) => [k2, redactValue(v, k2)]));
  }
  return value;
}

function redactRecord(r: Record<string, unknown> | null): Record<string, unknown> | null {
  return r === null ? null : (redactValue(r) as Record<string, unknown>);
}

/** A copy of the entry that is safe to show an admin: no emails, names or free-text content. */
export function redactAuditEntry(entry: AuditEntry): AuditEntry {
  return {
    ...entry,
    targetId: redactValue(entry.targetId) as string,
    before: redactRecord(entry.before),
    after: redactRecord(entry.after),
  };
}

export type AuditQuery = {
  actorId?: string;
  /** An exact action, or a prefix up to a dot, e.g. `incident` matches `incident.ended`. */
  action?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
};

const MAX_LIMIT = 500;
/** Page size when the caller asks for none, so the route is never unbounded. */
const DEFAULT_LIMIT = 100;

/** Parses the raw query string values; undefined when any value is invalid. */
export function parseAuditQuery(raw: unknown): AuditQuery | undefined {
  const r = (raw ?? {}) as Record<string, unknown>;
  const q: AuditQuery = { limit: DEFAULT_LIMIT };
  for (const key of ["actorId", "action", "from", "to"] as const) {
    const v = r[key];
    if (v === undefined) continue;
    if (typeof v !== "string" || v === "") return undefined;
    if ((key === "from" || key === "to") && Number.isNaN(Date.parse(v))) return undefined;
    q[key] = v;
  }
  for (const [key, min, max] of [
    ["limit", 1, MAX_LIMIT],
    ["offset", 0, Number.MAX_SAFE_INTEGER],
  ] as const) {
    const v = r[key];
    if (v === undefined) continue;
    const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : NaN;
    if (!Number.isSafeInteger(n) || n < min || n > max) return undefined;
    q[key] = n;
  }
  return q;
}

/** Filters entries (kept in time order) and applies offset and limit. */
export function queryAudit(entries: AuditEntry[], q: AuditQuery): AuditEntry[] {
  const from = q.from ? Date.parse(q.from) : undefined;
  const to = q.to ? Date.parse(q.to) : undefined;
  const filtered = entries.filter((e) => {
    if (q.actorId && e.actorId !== q.actorId) return false;
    if (q.action && e.action !== q.action && !e.action.startsWith(`${q.action}.`)) return false;
    const at = Date.parse(e.at);
    if (from !== undefined && at < from) return false;
    if (to !== undefined && at > to) return false;
    return true;
  });
  const offset = q.offset ?? 0;
  return filtered.slice(offset, q.limit === undefined ? undefined : offset + q.limit);
}
