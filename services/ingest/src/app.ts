import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { AppConfig } from "@my-wife/config";
import { InboundEmailWebhookRequestSchema } from "@my-wife/contracts";
import { createServiceApp, type ServiceDeps } from "@my-wife/service-kit";
import { processInbound, type PipelineDeps } from "./pipeline";

export const SERVICE_NAME = "ingest";
export const SECRET_HEADER = "x-ingest-secret";
export const WEBHOOK_PATH = "/webhook/inbound-email";

export type IngestDeps = Omit<PipelineDeps, "newId"> & {
  /** Shared secret expected in the `x-ingest-secret` header; never logged. */
  secret: string;
  newId?: () => string;
  /** Time source so the service can be simulated. */
  now: () => Date;
};

const digest = (s: string) => createHash("sha256").update(s).digest();

function secretMatches(given: unknown, expected: string): boolean {
  if (typeof given !== "string" || given.length === 0) return false;
  return timingSafeEqual(digest(given), digest(expected));
}

/** Factory used by main.ts, the dev runner and tests; no process-level globals (ADR 0007). */
export function createApp(config: AppConfig, deps: ServiceDeps & { ingest?: IngestDeps } = {}) {
  const app = createServiceApp({
    name: SERVICE_NAME,
    logLevel: config.logLevel,
    nats: deps.nats,
  });

  const ingest = deps.ingest;
  if (ingest) {
    // base64 inflates by 4/3; the exact size is checked again on the decoded message.
    const bodyLimit = Math.ceil((ingest.settings.maxEmailBytes * 4) / 3) + 4096;
    app.post(WEBHOOK_PATH, { bodyLimit }, async (req, reply) => {
      // Authenticate before looking at, parsing or storing anything.
      if (!secretMatches(req.headers[SECRET_HEADER], ingest.secret)) {
        return reply.code(401).send({ ok: false, error: { code: "unauthorized" } });
      }
      const body = InboundEmailWebhookRequestSchema.safeParse(req.body);
      if (!body.success) {
        return reply.code(400).send({ ok: false, error: { code: "invalid_request" } });
      }
      const outcome = await processInbound(
        { toAddress: body.data.toAddress, raw: Buffer.from(body.data.rawBase64, "base64") },
        { ...ingest, newId: ingest.newId ?? randomUUID },
        ingest.now(),
      );
      if (outcome.state === "unknown_address") {
        return reply.code(404).send({ ok: false, error: { code: "unknown_address" } });
      }
      if (outcome.state === "rejected") {
        return reply.code(422).send({ ok: false, error: { code: outcome.reason ?? "rejected" } });
      }
      return { ok: true, data: { receiptId: outcome.receiptId, state: outcome.state } };
    });
  }
  return app;
}
