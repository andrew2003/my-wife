import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { pino } from "pino";

export const TRACE_HEADER = "x-trace-id";

export type NatsHealth = { isClosed(): boolean };

export type ServiceAppOptions = {
  name: string;
  logLevel?: string;
  /** JSON logs go to stdout unless a stream is given (tests). */
  logStream?: Writable;
  /** Optional NATS connection; health reports it. */
  nats?: NatsHealth;
};

/** Shared Fastify skeleton: JSON logs with a trace ID, /health. No process-level globals (ADR 0007). */
export function createServiceApp(opts: ServiceAppOptions): FastifyInstance {
  const logger = pino(
    {
      level: opts.logLevel ?? "info",
      base: { service: opts.name },
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    opts.logStream,
  );

  const app = Fastify({
    loggerInstance: logger as unknown as FastifyBaseLogger,
    requestIdHeader: TRACE_HEADER,
    logController: new LogController({ requestIdLogLabel: "traceId" }),
    genReqId: () => randomUUID(),
  });

  app.addHook("onSend", async (req, reply) => {
    reply.header(TRACE_HEADER, req.id);
  });

  app.get("/health", async (_req, reply) => {
    const nats = opts.nats ? (opts.nats.isClosed() ? "down" : "up") : "disabled";
    const ok = nats !== "down";
    return reply
      .code(ok ? 200 : 503)
      .send({ status: ok ? "ok" : "degraded", service: opts.name, nats });
  });

  return app;
}
