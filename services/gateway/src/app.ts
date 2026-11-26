import type { AppConfig } from "@my-wife/config";
import { servicePort } from "@my-wife/config";
import { createServiceApp, type ServiceDeps } from "@my-wife/service-kit";

export const SERVICE_NAME = "gateway";
export const SESSION_COOKIE = "mw_session";
export const USER_ID_HEADER = "x-user-id";

export type GatewayOptions = {
  fetch?: typeof fetch;
  upstreams?: { identity: string; budget: string; schedule: string };
};

/** Routes reachable without a session. Everything else under /api needs one. */
const PUBLIC_ROUTES = new Set(["POST /api/invitations/accept"]);

/** Paths owned by the schedule service (daily checklist and task actions). */
const SCHEDULE_PREFIXES = ["/checklist", "/tasks", "/sessions", "/sample-schedule"];
const BUDGET_PREFIXES = ["/budget"];

function isUnder(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => path === p || path.startsWith(`${p}/`));
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

const unauthorized = { ok: false, error: { code: "gateway.unauthorized" } } as const;
const unavailable = { ok: false, error: { code: "gateway.upstream_unavailable" } } as const;

/** Factory used by main.ts, the dev runner and tests; no process-level globals (ADR 0007). */
export function createApp(config: AppConfig, deps: ServiceDeps = {}, options: GatewayOptions = {}) {
  const app = createServiceApp({
    name: SERVICE_NAME,
    logLevel: config.logLevel,
    nats: deps.nats,
  });
  const doFetch = options.fetch ?? fetch;
  const upstreams = options.upstreams ?? {
    identity: process.env.IDENTITY_URL ?? `http://localhost:${servicePort("identity")}`,
    budget: process.env.BUDGET_URL ?? `http://localhost:${servicePort("budget")}`,
    schedule: process.env.SCHEDULE_URL ?? `http://localhost:${servicePort("schedule")}`,
  };

  async function forward(
    base: string,
    path: string,
    method: string,
    body: unknown,
    userId?: string,
  ) {
    const headers: Record<string, string> = {};
    if (userId) headers[USER_ID_HEADER] = userId;
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
          return await send(await forward(upstreams.identity, path + suffix, req.method, req.body));
        }

        const token = readCookie(req.headers.cookie, SESSION_COOKIE);
        if (!token) return reply.code(401).send(unauthorized);
        const verified = await doFetch(`${upstreams.identity}/sessions/verify`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (!verified.ok) return reply.code(401).send(unauthorized);
        const session = (await verified.json()) as { data: { user: { id: string } } };

        if (path === "/me") return reply.code(200).send(session);

        const base = isUnder(path, BUDGET_PREFIXES)
          ? upstreams.budget
          : isUnder(path, SCHEDULE_PREFIXES)
            ? upstreams.schedule
            : upstreams.identity;
        return await send(
          await forward(base, path + suffix, req.method, req.body, session.data.user.id),
        );
      } catch (err) {
        req.log.error({ err: (err as Error).message }, "upstream request failed");
        return reply.code(502).send(unavailable);
      }
    },
  });
  return app;
}
