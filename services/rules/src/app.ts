import type { AppConfig } from "@my-wife/config";
import { parseEvent, SignContractRequestSchema, type EventEnvelope } from "@my-wife/contracts";
import { createServiceApp, type ServiceDeps } from "@my-wife/service-kit";
import { createContractService, InMemoryContractStore, type ContractStore } from "./contract";
import {
  createTrialService,
  InMemoryTrialStore,
  type TrialSettings,
  type TrialStore,
} from "./trial";

export const SERVICE_NAME = "rules";

export type RulesDeps = ServiceDeps & {
  publish?: (event: EventEnvelope) => void | Promise<void>;
  contractStore?: ContractStore;
  now?: () => Date;
  trialStore?: TrialStore;
  /** Reads the user's trial settings (identity `GET /settings`); registry defaults when absent. */
  readTrialSettings?: (userId: string) => Promise<TrialSettings>;
};

declare module "fastify" {
  interface FastifyInstance {
    /** The trial job; the caller (scheduler or test clock) passes `now`. */
    runTrialJob?: (now: Date) => Promise<void>;
  }
}

/** Factory used by main.ts, the dev runner and tests; no process-level globals (ADR 0007). */
export function createApp(config: AppConfig, deps: RulesDeps = {}) {
  const app = createServiceApp({
    name: SERVICE_NAME,
    logLevel: config.logLevel,
    nats: deps.nats,
  });

  const contracts = createContractService({
    store: deps.contractStore ?? new InMemoryContractStore(),
    publish: deps.publish,
    now: deps.now ?? (() => new Date()),
    onPublishError: (err) =>
      app.log.error(
        { err: err instanceof Error ? err.message : "unknown" },
        "contract.signed publish failed; it will be retried",
      ),
  });

  const trial = createTrialService({
    store: deps.trialStore ?? new InMemoryTrialStore(),
    publish: deps.publish,
    readSettings: deps.readTrialSettings,
    onPublishError: (err) =>
      app.log.error(
        { err: err instanceof Error ? err.message : "unknown" },
        "trial event publish failed; it will be retried",
      ),
  });
  app.decorate("runTrialJob", (now: Date) => trial.runJob(now));

  /** Internal entry for the bus bridge: `contract.signed` starts the user's trial. */
  app.post("/events/contract-signed", async (req, reply) => {
    const parsed = parseEvent(req.body);
    if (!parsed.success || parsed.data.type !== "contract.signed") {
      return reply.code(400).send({ ok: false, error: { code: "rules.invalid_event" } });
    }
    const now = (deps.now ?? (() => new Date()))();
    return { ok: true, data: await trial.onContractSigned(parsed.data as EventEnvelope, now) };
  });

  // The gateway has verified the session and forwards the user id (see decisions.md).
  app.post("/contracts/sign", async (req, reply) => {
    const userId = req.headers["x-user-id"];
    if (typeof userId !== "string" || userId === "") {
      return reply.code(401).send({ ok: false, error: { code: "unauthorized" } });
    }
    const body = SignContractRequestSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: { code: "invalid_request" } });
    }
    const { contract } = await contracts.sign(userId, body.data.cycleId);
    return { ok: true, data: { contract } };
  });
  return app;
}
