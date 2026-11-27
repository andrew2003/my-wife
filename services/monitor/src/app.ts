import type { AppConfig } from "@my-wife/config";
import {
  GiveReasonRequestSchema,
  StartBreakRequestSchema,
  HeartbeatRequestSchema,
  MonitorStartSessionRequestSchema,
  type EventEnvelope,
  type OutboundMessage,
  type SettingKey,
} from "@my-wife/contracts";
import { createServiceApp, type ServiceDeps } from "@my-wife/service-kit";
import {
  createMemoryBreakStore,
  type BreakResult,
  endBreak,
  startBreak,
  createMemoryNudgeStore,
  createMemorySessionStore,
  processSoftSignals,
  createMemoryTicketStore,
  createMemoryUrgentStore,
  endMonitoring,
  giveReason,
  recordHeartbeat,
  runGapCheck,
  runUrgentJob,
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
  /** Hands an urgent message to notify (`POST /messages`); the default throws, so nothing counts as delivered until notify is wired. */
  sendUrgent?: (message: OutboundMessage) => Promise<void>;
  /** Storage ports; in memory until the Drizzle stores land. */
  state?: Partial<MonitorState>;
};

declare module "fastify" {
  interface FastifyInstance {
    /** Opens tickets for sessions whose heartbeat is missing; the caller passes `now`. */
    runGapCheck: (now: Date) => Promise<{ tickets: string[]; failed: string[] }>;
    /** Sends, escalates and expires urgent messages; the caller passes `now`. */
    runUrgentJob: (now: Date) => Promise<{ failed: string[] }>;
    monitorState: MonitorState;
    /** Starts a planned pause (pomodoro, meal); internal callers only, no HTTP route. */
    startScheduledBreak: (
      userId: string,
      sessionId: string,
      minutes: number,
    ) => Promise<BreakResult>;
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
    breaks: deps.state?.breaks ?? createMemoryBreakStore(),
    nudges: deps.state?.nudges ?? createMemoryNudgeStore(),
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
    sendUrgent:
      deps.sendUrgent ??
      (async () => {
        throw new Error("notify is not wired");
      }),
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
    const session = monitor.state.sessions.get(userId, parsed.data.sessionId);
    const nudges = session
      ? await processSoftSignals(monitor, session, parsed.data.events, monitor.now())
      : [];
    return {
      ok: true,
      data: { nudges: nudges.map((n) => ({ signal: n.signal, messageKey: n.messageKey })) },
    };
  });

  app.post("/sessions/:id/end", async (req, reply) => {
    const userId = userOf(req.headers);
    if (!userId) return fail(reply, 401, "monitor.unauthenticated");
    const s = await endMonitoring(monitor, userId, (req.params as { id: string }).id);
    if (!s) return fail(reply, 404, "monitor.session_not_found");
    return { ok: true, data: { sessionId: s.id, endedAt: s.endedAt } };
  });

  app.post("/reasons", async (req, reply) => {
    const userId = userOf(req.headers);
    if (!userId) return fail(reply, 401, "monitor.unauthenticated");
    const parsed = GiveReasonRequestSchema.safeParse(req.body);
    if (!parsed.success) return fail(reply, 400, "monitor.invalid_request");
    const res = await giveReason(monitor, userId, parsed.data, monitor.now());
    if (!res.ok) return fail(reply, res.error === "ticket.not_found" ? 404 : 409, res.error);
    const scoredAs = res.ticket.scoredAs;
    return {
      ok: true,
      data: {
        ticketId: res.ticket.id,
        state: res.ticket.state,
        scoredAs,
        ...(scoredAs === "silence" ? { messageKey: "monitor.reason.over_quota" } : {}),
      },
    };
  });

  const breakReply = (
    reply: { code(n: number): unknown },
    res: Awaited<ReturnType<typeof startBreak>>,
  ) => {
    if (res.ok) {
      return { ok: true, data: { breakId: res.break.id, allowedUntil: res.break.allowedUntil } };
    }
    return fail(reply, res.error === "session.not_found" ? 404 : 409, res.error);
  };
  app.post("/breaks/start", async (req, reply) => {
    const userId = userOf(req.headers);
    if (!userId) return fail(reply, 401, "monitor.unauthenticated");
    const parsed = StartBreakRequestSchema.safeParse(req.body);
    if (!parsed.success) return fail(reply, 400, "monitor.invalid_request");
    const input = { sessionId: parsed.data.sessionId, kind: "manual" as const };
    return breakReply(reply, await startBreak(monitor, userId, input, monitor.now()));
  });
  /**
   * In-process port for pomodoro and meal breaks until schedule's break state is consumed (#389).
   * Deliberately not an HTTP route: a user-facing call must not choose its own break length.
   */
  app.decorate("startScheduledBreak", (userId: string, sessionId: string, minutes: number) =>
    startBreak(monitor, userId, { sessionId, kind: "scheduled", minutes }, monitor.now()),
  );
  app.post("/breaks/end", async (req, reply) => {
    const userId = userOf(req.headers);
    if (!userId) return fail(reply, 401, "monitor.unauthenticated");
    const parsed = StartBreakRequestSchema.safeParse(req.body);
    if (!parsed.success) return fail(reply, 400, "monitor.invalid_request");
    return breakReply(reply, await endBreak(monitor, userId, parsed.data.sessionId, monitor.now()));
  });

  /** Entry for the scheduler and the dev-runner clock; `now` is a parameter. */
  app.decorate("runGapCheck", (at: Date) => runGapCheck(monitor, at));
  app.decorate("runUrgentJob", (at: Date) => runUrgentJob(monitor, at));
  app.decorate("monitorState", state);
  app.post("/jobs/gap-check", async () => ({
    ok: true,
    data: await runGapCheck(monitor, monitor.now()),
  }));
  app.post("/jobs/urgent", async () => ({
    ok: true,
    data: await runUrgentJob(monitor, monitor.now()),
  }));
  return app;
}
