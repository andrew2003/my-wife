import type { AppConfig } from "@my-wife/config";
import {
  HeartbeatRequestSchema,
  MonitorStartSessionRequestSchema,
  type EventEnvelope,
  type SettingKey,
} from "@my-wife/contracts";
import { createServiceApp, type ServiceDeps } from "@my-wife/service-kit";
import {
  createMemorySessionStore,
  createMemoryTicketStore,
  createMemoryUrgentStore,
  endMonitoring,
  recordHeartbeat,
  runGapCheck,
  startMonitoring,
  type MonitorDeps,
  type MonitorState,
} from "./monitoring";

export const SERVICE_NAME = "monitor";

export type MonitorServiceDeps = ServiceDeps & {
  /** Time is a parameter so tests can simulate it. */
  now?: () => Date;
  /** Reads the user's settings (identity `GET /settings` in production). */
  readSettings?: (userId: string) => Promise<Partial<Record<SettingKey, unknown>>>;
  /** Announces events on the bus; a no-op without NATS. */
  publish?: (event: EventEnvelope) => void | Promise<void>;
  /** Storage ports; in memory until the Drizzle stores land. */
  state?: Partial<MonitorState>;
};

declare module "fastify" {
  interface FastifyInstance {
    /** Opens tickets for sessions whose heartbeat is missing; the caller passes `now`. */
    runGapCheck: (now: Date) => Promise<{ tickets: string[]; failed: string[] }>;
    monitorState: MonitorState;
  }
}

/** Factory used by main.ts, the dev runner and tests; no process-level globals (ADR 0007). */
export function createApp(config: AppConfig, deps: MonitorServiceDeps = {}) {
  const app = createServiceApp({
    name: SERVICE_NAME,
    logLevel: config.logLevel,
    nats: deps.nats,
  });
  const state: MonitorState = {
    sessions: deps.state?.sessions ?? createMemorySessionStore(),
    tickets: deps.state?.tickets ?? createMemoryTicketStore(),
    urgent: deps.state?.urgent ?? createMemoryUrgentStore(),
  };
  const monitor: MonitorDeps = {
    state,
    now: deps.now ?? (() => new Date()),
    publish: deps.publish ?? (() => undefined),
    readSettings: deps.readSettings ?? (async () => ({})),
    locale: config.uiLanguage,
  };

  const fail = (reply: { code(n: number): unknown }, status: number, code: string) => {
    reply.code(status);
    return { ok: false, error: { code } };
  };
  const userOf = (headers: Record<string, unknown>) => {
    const id = headers["x-user-id"];
    return typeof id === "string" && id ? id : undefined;
  };

  app.post("/sessions/start", async (req, reply) => {
    const userId = userOf(req.headers);
    if (!userId) return fail(reply, 401, "monitor.unauthenticated");
    const parsed = MonitorStartSessionRequestSchema.safeParse(req.body);
    if (!parsed.success) return fail(reply, 400, "monitor.invalid_request");
    const res = await startMonitoring(monitor, userId, parsed.data);
    if (!res.ok) return fail(reply, 409, res.error);
    return { ok: true, data: { sessionId: res.session.id, startedAt: res.session.startedAt } };
  });

  /** Heartbeats carry filtered events only; the schema is strict, so a frame is rejected. */
  app.post("/heartbeat", async (req, reply) => {
    const userId = userOf(req.headers);
    if (!userId) return fail(reply, 401, "monitor.unauthenticated");
    const parsed = HeartbeatRequestSchema.safeParse(req.body);
    if (!parsed.success) return fail(reply, 400, "monitor.invalid_request");
    const res = recordHeartbeat(monitor, userId, parsed.data.sessionId);
    if (res === "not_found") return fail(reply, 404, "monitor.session_not_found");
    if (res === "ended") return fail(reply, 409, "monitor.session_ended");
    return { ok: true, data: {} };
  });

  app.post("/sessions/:id/end", async (req, reply) => {
    const userId = userOf(req.headers);
    if (!userId) return fail(reply, 401, "monitor.unauthenticated");
    const s = await endMonitoring(monitor, userId, (req.params as { id: string }).id);
    if (!s) return fail(reply, 404, "monitor.session_not_found");
    return { ok: true, data: { sessionId: s.id, endedAt: s.endedAt } };
  });

  /** Entry for the scheduler and the dev-runner clock; `now` is a parameter. */
  app.decorate("runGapCheck", (at: Date) => runGapCheck(monitor, at));
  app.decorate("monitorState", state);
  app.post("/jobs/gap-check", async () => ({
    ok: true,
    data: await runGapCheck(monitor, monitor.now()),
  }));
  return app;
}
