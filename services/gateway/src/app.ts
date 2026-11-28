import type { AppConfig } from "@my-wife/config";
import { servicePort } from "@my-wife/config";
import { createServiceApp, type ServiceDeps } from "@my-wife/service-kit";

export const SERVICE_NAME = "gateway";
export const SESSION_COOKIE = "mw_session";
export const USER_ID_HEADER = "x-user-id";
export const USER_ROLE_HEADER = "x-user-role";

export type GatewayOptions = {
  fetch?: typeof fetch;
  upstreams?: {
    identity: string;
    budget: string;
    schedule: string;
    rules: string;
    ai?: string;
    notify?: string;
    ingest?: string;
    monitor?: string;
    sync?: string;
  };
};

/** Routes reachable without a session. Everything else under /api needs one. */
const PUBLIC_ROUTES = new Set(["POST /api/invitations/accept"]);

/** Paths owned by the schedule service (daily checklist and task actions). */
const SCHEDULE_PREFIXES = [
  "/checklist",
  "/tasks",
  "/sessions",
  "/wake",
  "/sample-schedule",
  "/weeks",
  "/templates",
  "/recurrences",
  "/timetable-sheet",
];
/** Paths owned by the sync service (Google link and status). */
const SYNC_PREFIXES = ["/sync"];
/** Admin API (spec 50): owned by identity, needs role admin. */
const ADMIN_PREFIXES = ["/admin"];
const BUDGET_PREFIXES = ["/budget"];
/** Paths owned by the rules service (contracts, penalties, faults and appeals). */
const RULES_PREFIXES = ["/contracts", "/penalties", "/faults", "/appeals"];

/**
 * Prefixes owned by ai, notify, ingest and monitor. Entries in the first list keep their
 * path; the service prefix itself (for example /notify/inbox) is stripped before forwarding.
 */
const AI_PREFIXES = ["/keys", "/models", "/chat"];
const NOTIFY_PREFIXES = ["/push"];
const STRIPPED_PREFIXES = ["/ai", "/notify", "/ingest", "/monitor"] as const;
type StrippedService = "ai" | "notify" | "ingest" | "monitor";

function isUnder(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => path === p || path.startsWith(`${p}/`));
}

/**
 * Decode, lowercase and collapse a request path for authorisation and routing.
 * Returns undefined for malformed escapes, dot segments or an encoded slash/backslash,
 * which the caller rejects with 400.
 */
function normalizePath(rawPath: string): { key: string; clean: string } | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return undefined;
  }
  if (decoded.includes("\\") || (decoded !== rawPath && /%2f/i.test(rawPath))) return undefined;
  const segments = decoded.split("/").filter((s) => s !== "");
  if (segments.some((s) => s === "." || s === ".." || s.includes("%"))) return undefined;
  return {
    key: `/${segments.join("/").toLowerCase()}`,
    clean: `/${segments.map(encodeURIComponent).join("/")}`,
  };
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

const unauthorized = { ok: false, error: { code: "gateway.unauthorized" } } as const;
const forbidden = { ok: false, error: { code: "gateway.forbidden" } } as const;
const badRequest = { ok: false, error: { code: "gateway.bad_path" } } as const;
const unavailable = { ok: false, error: { code: "gateway.upstream_unavailable" } } as const;

/** Factory used by main.ts, the dev runner and tests; no process-level globals (ADR 0007). */
export function createApp(config: AppConfig, deps: ServiceDeps = {}, options: GatewayOptions = {}) {
  const app = createServiceApp({
    name: SERVICE_NAME,
    logLevel: config.logLevel,
    nats: deps.nats,
  });
  const doFetch = options.fetch ?? fetch;
  const url = (envName: string, service: Parameters<typeof servicePort>[0]) =>
    process.env[envName] ?? `http://localhost:${servicePort(service)}`;
  const given = options.upstreams;
  const upstreams = {
    identity: given?.identity ?? url("IDENTITY_URL", "identity"),
    budget: given?.budget ?? url("BUDGET_URL", "budget"),
    schedule: given?.schedule ?? url("SCHEDULE_URL", "schedule"),
    rules: given?.rules ?? url("RULES_URL", "rules"),
    ai: given?.ai ?? url("AI_URL", "ai"),
    notify: given?.notify ?? url("NOTIFY_URL", "notify"),
    ingest: given?.ingest ?? url("INGEST_URL", "ingest"),
    monitor: given?.monitor ?? url("MONITOR_URL", "monitor"),
    sync: given?.sync ?? url("SYNC_URL", "sync"),
  };

  async function forward(
    base: string,
    path: string,
    method: string,
    body: unknown,
    userId?: string,
    role?: string,
  ) {
    const headers: Record<string, string> = {};
    if (userId) headers[USER_ID_HEADER] = userId;
    // Set from the verified session only; a client-supplied value is never forwarded.
    if (role) headers[USER_ROLE_HEADER] = role;
    let payload: string | undefined;
    if (body !== undefined && method !== "GET" && method !== "HEAD") {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    return doFetch(`${base}${path}`, { method, headers, body: payload });
  }

  app.route({
    method: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    url: "/api/*",
    handler: async (req, reply) => {
      const [rawPath = "", query] = req.url.split("?");
      const path = rawPath.replace(/^\/api/, "") || "/";
      const normalized = normalizePath(path);
      if (normalized === undefined) return reply.code(400).send(badRequest);
      const suffix = query ? `?${query}` : "";
      const send = async (res: Response) => {
        const text = await res.text();
        reply.code(res.status);
        const type = res.headers.get("content-type");
        if (type) reply.header("content-type", type);
        return reply.send(text);
      };

      try {
        if (PUBLIC_ROUTES.has(`${req.method} ${rawPath}`)) {
          return await send(
            await forward(upstreams.identity, normalized.clean + suffix, req.method, req.body),
          );
        }

        const token = readCookie(req.headers.cookie, SESSION_COOKIE);
        if (!token) return reply.code(401).send(unauthorized);
        const verified = await doFetch(`${upstreams.identity}/sessions/verify`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (!verified.ok) return reply.code(401).send(unauthorized);
        const session = (await verified.json()) as {
          data: { user: { id: string; role?: string } };
        };

        if (isUnder(normalized.key, ADMIN_PREFIXES) && session.data.user.role !== "admin") {
          return reply.code(403).send(forbidden);
        }

        if (normalized.key === "/me") return reply.code(200).send(session);

        const owner = STRIPPED_PREFIXES.find((p) => isUnder(normalized.key, [p]));
        if (owner) {
          const rest = normalized.clean.slice(owner.length) || "/";
          return await send(
            await forward(
              upstreams[owner.slice(1) as StrippedService],
              rest + suffix,
              req.method,
              req.body,
              session.data.user.id,
            ),
          );
        }

        const base = isUnder(normalized.key, AI_PREFIXES)
          ? upstreams.ai
          : isUnder(normalized.key, NOTIFY_PREFIXES)
            ? upstreams.notify
            : isUnder(normalized.key, SYNC_PREFIXES)
              ? upstreams.sync
              : isUnder(normalized.key, BUDGET_PREFIXES)
                ? upstreams.budget
                : isUnder(normalized.key, SCHEDULE_PREFIXES)
                  ? upstreams.schedule
                  : isUnder(normalized.key, RULES_PREFIXES)
                    ? upstreams.rules
                    : upstreams.identity;
        return await send(
          await forward(
            base,
            normalized.clean + suffix,
            req.method,
            req.body,
            session.data.user.id,
            session.data.user.role,
          ),
        );
      } catch (err) {
        req.log.error({ err: (err as Error).message }, "upstream request failed");
        return reply.code(502).send(unavailable);
      }
    },
  });
  return app;
}
