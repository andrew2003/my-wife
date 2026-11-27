import type { AppConfig } from "@my-wife/config";
import { parseEvent, SignContractRequestSchema, type EventEnvelope } from "@my-wife/contracts";
import { createServiceApp, type ServiceDeps } from "@my-wife/service-kit";
import { createContractService, InMemoryContractStore, type ContractStore } from "./contract";
import {
  createFaultService,
  InMemoryFaultStore,
  type FaultSettings,
  type FaultStore,
} from "./fault";
import {
  createPenaltyService,
  InMemoryPenaltyStore,
  type PenaltyServiceDeps,
  type PenaltySettings,
  type PenaltyStore,
} from "./penalty";
import {
  createTrialService,
  InMemoryTrialStore,
  type SettlementLine,
  type TrialSettings,
  type TrialStore,
} from "./trial";

export const SERVICE_NAME = "rules";

export type RulesDeps = ServiceDeps & {
  publish?: (event: EventEnvelope) => void | Promise<void>;
  contractStore?: ContractStore;
  now?: () => Date;
  trialStore?: TrialStore;
  penaltyStore?: PenaltyStore;
  /** Reads the user's penalty settings (identity `GET /settings`); registry defaults when absent. */
  readPenaltySettings?: (userId: string) => Promise<PenaltySettings>;
  faultStore?: FaultStore;
  /** Fault settings in force at the given time (identity `GET /settings`); registry defaults when absent. */
  readFaultSettings?: (userId: string, at: Date) => Promise<FaultSettings>;
  /** Resolves the `MW-PH-...` payment code (cycle sequence and category code live in budget). */
  resolveTransferCode?: PenaltyServiceDeps["resolveTransferCode"];
  /**
   * Tells whether a parsed account hint (trailing digits) is the user's penalty savings account
   * (budget account of kind `penalty_savings`). Defaults to the seeded code `PEN`.
   */
  isPenaltySavingsAccount?: PenaltyServiceDeps["isPenaltySavingsAccount"];
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

  const contractStore = deps.contractStore ?? new InMemoryContractStore();
  const contracts = createContractService({
    store: contractStore,
    publish: deps.publish,
    now: deps.now ?? (() => new Date()),
    onPublishError: (err) =>
      app.log.error(
        { err: err instanceof Error ? err.message : "unknown" },
        "contract.signed publish failed; it will be retried",
      ),
  });

  const trialStore = deps.trialStore ?? new InMemoryTrialStore();
  // Assigned below; the trial job only runs after the app is built.
  let settlePenalties: (
    userId: string,
    lines: SettlementLine[],
    now: Date,
  ) => Promise<void> = async () => {};
  const trial = createTrialService({
    store: trialStore,
    publish: deps.publish,
    readSettings: deps.readTrialSettings,
    onSettled: (userId, lines, now) => settlePenalties(userId, lines, now),
    onPublishError: (err) =>
      app.log.error(
        { err: err instanceof Error ? err.message : "unknown" },
        "trial event publish failed; it will be retried",
      ),
  });
  app.decorate("runTrialJob", (now: Date) => trial.runJob(now));

  const faults = createFaultService({
    store: deps.faultStore ?? new InMemoryFaultStore(),
    publish: deps.publish,
    readSettings: deps.readFaultSettings,
    onPublishError: (err) =>
      app.log.error(
        { err: err instanceof Error ? err.message : "unknown" },
        "fault event publish failed; it will be retried",
      ),
  });

  const penaltyStore = deps.penaltyStore ?? new InMemoryPenaltyStore();
  const penalties = createPenaltyService({
    store: penaltyStore,
    trialStore,
    contractStore,
    publish: deps.publish,
    readSettings: deps.readPenaltySettings,
    resolveTransferCode: deps.resolveTransferCode,
    isPenaltySavingsAccount: deps.isPenaltySavingsAccount,
    onPublishError: (err) =>
      app.log.error(
        { err: err instanceof Error ? err.message : "unknown" },
        "penalty event publish failed; it will be retried",
      ),
  });

  settlePenalties = (userId, lines, now) => penalties.onTrialSettled(userId, lines, now);

  /** Internal entry for the bus bridge: `overspend.detected` becomes an overspend penalty. */
  app.post("/events/overspend-detected", async (req, reply) => {
    const parsed = parseEvent(req.body);
    if (!parsed.success || parsed.data.type !== "overspend.detected") {
      return reply.code(400).send({ ok: false, error: { code: "rules.invalid_event" } });
    }
    const now = (deps.now ?? (() => new Date()))();
    return {
      ok: true,
      data: await penalties.onOverspendDetected(parsed.data as EventEnvelope, now),
    };
  });

  /** Internal entry for the bus bridge: `receipt.parsed` may pay a due penalty. */
  app.post("/events/receipt-parsed", async (req, reply) => {
    const parsed = parseEvent(req.body);
    if (!parsed.success || parsed.data.type !== "receipt.parsed") {
      return reply.code(400).send({ ok: false, error: { code: "rules.invalid_event" } });
    }
    const now = (deps.now ?? (() => new Date()))();
    return { ok: true, data: await penalties.onReceiptParsed(parsed.data as EventEnvelope, now) };
  });

  /** Internal entry for the bus bridge: `fault.detected` becomes a ledger entry. */
  app.post("/events/fault-detected", async (req, reply) => {
    const parsed = parseEvent(req.body);
    if (!parsed.success || parsed.data.type !== "fault.detected") {
      return reply.code(400).send({ ok: false, error: { code: "rules.invalid_event" } });
    }
    const now = (deps.now ?? (() => new Date()))();
    return { ok: true, data: await faults.onFaultDetected(parsed.data as EventEnvelope, now) };
  });

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
  app.get("/penalties", async (req, reply) => {
    const userId = req.headers["x-user-id"];
    if (typeof userId !== "string" || userId === "") {
      return reply.code(401).send({ ok: false, error: { code: "unauthorized" } });
    }
    const list = [...penaltyStore.list(userId)];
    const suspendedTotalVnd = list
      .filter((p) => p.status === "suspended")
      .reduce((sum, p) => sum + p.amountVnd, 0);
    // Internal bookkeeping fields (such as the source key) are not part of the contract.
    const penalties = list.map((p) => ({
      id: p.id,
      source: p.source,
      amountVnd: p.amountVnd,
      status: p.status,
      dueDate: p.dueDate,
      transferCode: p.transferCode,
      paymentTransactionId: p.paymentTransactionId ?? null,
      auditRefs: [...p.auditRefs],
      contractId: p.contractId ?? null,
    }));
    return { ok: true, data: { penalties, suspendedTotalVnd } };
  });

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
