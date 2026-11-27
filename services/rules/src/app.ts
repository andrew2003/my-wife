import type { AppConfig } from "@my-wife/config";
import {
  DecideAppealRequestSchema,
  IdSchema,
  OpenAppealRequestSchema,
  parseEvent,
  SignContractRequestSchema,
  type EventEnvelope,
} from "@my-wife/contracts";
import { createServiceApp, type ServiceDeps } from "@my-wife/service-kit";
import {
  createAppealService,
  InMemoryAppealStore,
  type AppealRecord,
  type AppealSettings,
  type AppealStore,
} from "./appeal";
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
import { InMemoryPenaltyDebtStore, type PenaltyDebtStore } from "./penalty-source";
import {
  createTrialService,
  InMemoryTrialStore,
  type SettlementLine,
  type TrialSettings,
  type TrialStore,
} from "./trial";

function toAppealView(a: AppealRecord) {
  return {
    id: a.id,
    subjectKind: a.subjectKind,
    subjectId: a.subjectId,
    status: a.status,
    reasonText: a.reasonText,
    openedAt: a.openedAt,
    windowEndsAt: a.windowEndsAt,
    hasEvidenceFrame: a.hasEvidenceFrame,
  };
}

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
  /** Penalty debt carried over (source exhaustion); in memory when absent. */
  penaltyDebtStore?: PenaltyDebtStore;
  /** The user's `want` categories with unspent limit (budget); no allocation when absent. */
  readWantList?: PenaltyServiceDeps["readWantList"];
  appealStore?: AppealStore;
  /** Reads the user's appeal settings (`appeal.window_hours`); registry defaults when absent. */
  readAppealSettings?: (userId: string) => Promise<AppealSettings>;
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

  const faultStore = deps.faultStore ?? new InMemoryFaultStore();
  const faults = createFaultService({
    store: faultStore,
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
    debtStore: deps.penaltyDebtStore ?? new InMemoryPenaltyDebtStore(),
    readWantList: deps.readWantList,
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

  /** Internal entry for the bus bridge: a penalty savings withdrawal becomes a flagged penalty. */
  app.post("/events/penalty-savings-withdrawal", async (req, reply) => {
    const parsed = parseEvent(req.body);
    if (!parsed.success || parsed.data.type !== "penalty_savings.withdrawal_detected") {
      return reply.code(400).send({ ok: false, error: { code: "rules.invalid_event" } });
    }
    const now = (deps.now ?? (() => new Date()))();
    return {
      ok: true,
      data: await penalties.onWithdrawalDetected(parsed.data as EventEnvelope, now),
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
    const list = penaltyStore.list(userId).filter((p) => !p.reversedAt);
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

  const appeals = createAppealService({
    store: deps.appealStore ?? new InMemoryAppealStore(),
    faultStore,
    penaltyStore,
    publish: deps.publish,
    readSettings: deps.readAppealSettings,
    onPublishError: (err) =>
      app.log.error(
        { err: err instanceof Error ? err.message : "unknown" },
        "appeal event publish failed; it will be retried",
      ),
  });

  app.post("/appeals", async (req, reply) => {
    const userId = req.headers["x-user-id"];
    if (typeof userId !== "string" || userId === "") {
      return reply.code(401).send({ ok: false, error: { code: "unauthorized" } });
    }
    const body = OpenAppealRequestSchema.extend({ penaltyId: IdSchema.optional() }).safeParse(
      req.body,
    );
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: { code: "invalid_request" } });
    }
    const now = (deps.now ?? (() => new Date()))();
    const result = await appeals.open(userId, body.data, now);
    if (!result.ok) {
      return reply.code(409).send({ ok: false, error: { code: result.error } });
    }
    return { ok: true, data: { appeal: toAppealView(result.appeal) } };
  });

  // Decisions are made by code or by the user's accountability rules, never by the AI; this
  // route is internal (not forwarded by the gateway).
  app.post("/appeals/decide", async (req, reply) => {
    const userId = req.headers["x-user-id"];
    if (typeof userId !== "string" || userId === "") {
      return reply.code(401).send({ ok: false, error: { code: "unauthorized" } });
    }
    const body = DecideAppealRequestSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: { code: "invalid_request" } });
    }
    const now = (deps.now ?? (() => new Date()))();
    const { appealId, outcome, note } = body.data;
    const result = await appeals.decide(userId, appealId, outcome, now, note);
    if (!result.ok) {
      const code = result.error === "rules.appeal_not_found" ? 404 : 409;
      return reply.code(code).send({ ok: false, error: { code: result.error } });
    }
    return { ok: true, data: { appeal: toAppealView(result.appeal) } };
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
