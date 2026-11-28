import type { AppConfig } from "@my-wife/config";
import {
  AppealFrameRequestSchema,
  DecideAppealRequestSchema,
  IdSchema,
  OpenAppealRequestSchema,
  parseEvent,
  SETTINGS,
  SignContractRequestSchema,
  type ConsentKind,
  type EventEnvelope,
  type EventPayload,
} from "@my-wife/contracts";
import { createServiceApp, type ServiceDeps } from "@my-wife/service-kit";
import {
  createAppealService,
  InMemoryAppealStore,
  type AppealFrameStore,
  type AppealRecord,
  type AppealSettings,
  type AppealStore,
} from "./appeal";
import {
  createCycleContractService,
  InMemoryCycleContractStore,
  type CycleContractStore,
} from "./cycle-contract";
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

import {
  createWeeklyPenaltyService,
  InMemoryWeeklyPenaltyStore,
  type WeeklyPenaltyStore,
} from "./weekly-fault-penalty";
import type { WeeklyPenaltySettings } from "./weekly-penalty";
import {
  createRewardService,
  InMemoryRewardStore,
  type RewardSettings,
  type RewardStore,
} from "./reward";

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
  /** Weekly computations (one per user and week); in memory when absent. */
  weeklyPenaltyStore?: WeeklyPenaltyStore;
  /** Fault thresholds and weekly cap in force (identity `GET /settings`); registry defaults when absent. */
  readWeeklyPenaltySettings?: (userId: string, at: Date) => Promise<WeeklyPenaltySettings>;
  /** Clean-week reward results (one per user and week); in memory when absent. */
  rewardStore?: RewardStore;
  /** Reward streak, amount and target in force; registry defaults when absent. */
  readRewardSettings?: (userId: string, at: Date) => Promise<RewardSettings>;
  appealStore?: AppealStore;
  /** Short-lived store for the consented appeal frame; frames are refused when absent. */
  appealFrameStore?: AppealFrameStore;
  /** Reads whether the user holds a consent (identity); every consent is missing when absent. */
  hasConsent?: (userId: string, kind: ConsentKind) => Promise<boolean>;
  /** Reads the user's appeal settings (`appeal.window_hours`); registry defaults when absent. */
  readAppealSettings?: (userId: string) => Promise<AppealSettings>;
  /** Reads the user's trial settings (identity `GET /settings`); registry defaults when absent. */
  readTrialSettings?: (userId: string) => Promise<TrialSettings>;
  cycleContractStore?: CycleContractStore;
  /** `budget.cycle_weeks` and `calendar.time_zone` of the user; registry defaults when absent. */
  readCycleSettings?: (userId: string) => { cycleWeeks: number; timeZone: string };
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

  const cycleContracts = createCycleContractService({
    store: deps.cycleContractStore ?? new InMemoryCycleContractStore(),
    contracts: contractStore,
    readSettings:
      deps.readCycleSettings ??
      (() => ({
        cycleWeeks: SETTINGS["budget.cycle_weeks"].default,
        timeZone: SETTINGS["calendar.time_zone"].default,
      })),
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
    isHeld: async (userId, entryId) => {
      const p = penaltyStore.list(userId).find((e) => e.id === entryId);
      return !!p && (!!p.appealId || !!p.reversedAt);
    },
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

  const weeklyPenalties = createWeeklyPenaltyService({
    faultStore,
    weeklyStore: deps.weeklyPenaltyStore ?? new InMemoryWeeklyPenaltyStore(),
    penalties,
    readSettings: deps.readWeeklyPenaltySettings,
  });

  /** Internal entry for the bus bridge: `week.closed` issues the week's monitoring penalty. */
  app.post("/events/week-closed", async (req, reply) => {
    const parsed = parseEvent(req.body);
    if (!parsed.success || parsed.data.type !== "week.closed") {
      return reply.code(400).send({ ok: false, error: { code: "rules.invalid_event" } });
    }
    const now = (deps.now ?? (() => new Date()))();
    return {
      ok: true,
      data: await weeklyPenalties.onWeekClosed(parsed.data as EventEnvelope, now),
    };
  });

  const rewards = createRewardService({
    faultStore,
    store: deps.rewardStore ?? new InMemoryRewardStore(),
    readSettings: deps.readRewardSettings,
    publish: deps.publish,
    onPublishError: (err) =>
      app.log.error(
        { err: err instanceof Error ? err.message : "unknown" },
        "reward event publish failed; it will be retried",
      ),
  });

  /** Internal entry for the bus bridge: `week.closed` unlocks the clean-week reward. */
  app.post("/events/week-closed-reward", async (req, reply) => {
    const parsed = parseEvent(req.body);
    if (!parsed.success || parsed.data.type !== "week.closed") {
      return reply.code(400).send({ ok: false, error: { code: "rules.invalid_event" } });
    }
    const now = (deps.now ?? (() => new Date()))();
    return { ok: true, data: await rewards.onWeekClosed(parsed.data as EventEnvelope, now) };
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

  // Internal: turning the trial off ends it at once (the account-closing flow passes the reason).
  app.post("/trial/turn-off", async (req, reply) => {
    const userId = req.headers["x-user-id"];
    if (typeof userId !== "string" || userId === "") {
      return reply.code(401).send({ ok: false, error: { code: "unauthorized" } });
    }
    const reason = (req.body as { reason?: unknown } | null)?.reason ?? "turned_off";
    if (reason !== "turned_off" && reason !== "account_closing") {
      return reply.code(400).send({ ok: false, error: { code: "invalid_request" } });
    }
    const now = (deps.now ?? (() => new Date()))();
    return { ok: true, data: await trial.endEarly(userId, reason, now) };
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

  const FAULTS_DEFAULT_PAGE = 50;
  const FAULTS_MAX_PAGE = 100;
  const CURSOR_PATTERN = /^[0-9TZ:.-]+\|[0-9a-f-]{36}$/i;

  // Newest first, keyset-paginated; `nextCursor` is opaque and null on the last page.
  app.get("/faults", async (req, reply) => {
    const userId = req.headers["x-user-id"];
    if (typeof userId !== "string" || userId === "") {
      return reply.code(401).send({ ok: false, error: { code: "unauthorized" } });
    }
    const query = req.query as { limit?: string; cursor?: string };
    let limit = FAULTS_DEFAULT_PAGE;
    if (query.limit !== undefined) {
      if (!/^\d+$/.test(query.limit) || Number(query.limit) < 1) {
        return reply.code(400).send({ ok: false, error: { code: "invalid_limit" } });
      }
      limit = Math.min(Number(query.limit), FAULTS_MAX_PAGE);
    }
    let after: string | null = null;
    if (query.cursor !== undefined && query.cursor !== "") {
      after = Buffer.from(query.cursor, "base64url").toString("utf8");
      if (!CURSOR_PATTERN.test(after)) {
        return reply.code(400).send({ ok: false, error: { code: "invalid_cursor" } });
      }
    }
    const page = faultStore.listPage(userId, limit, after);
    // Internal bookkeeping (honestReason) is not part of the contract.
    const faults = page.items.map(({ honestReason: _honest, ...f }) => f);
    const nextCursor = page.next === null ? null : Buffer.from(page.next).toString("base64url");
    return { ok: true, data: { faults, nextCursor } };
  });

  const appeals = createAppealService({
    store: deps.appealStore ?? new InMemoryAppealStore(),
    frameStore: deps.appealFrameStore,
    hasConsent: deps.hasConsent,
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

  // The single consented frame of an appeal; deleted when the appeal is decided.
  app.post("/appeals/frame", async (req, reply) => {
    const userId = req.headers["x-user-id"];
    if (typeof userId !== "string" || userId === "") {
      return reply.code(401).send({ ok: false, error: { code: "unauthorized" } });
    }
    const body = AppealFrameRequestSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: { code: "invalid_request" } });
    }
    const now = (deps.now ?? (() => new Date()))();
    const result = await appeals.attachFrame(
      userId,
      body.data.appealId,
      body.data.frameBase64,
      now,
    );
    if (!result.ok) {
      const code =
        result.error === "rules.appeal_not_found"
          ? 404
          : result.error === "rules.consent_missing"
            ? 403
            : 409;
      return reply.code(code).send({ ok: false, error: { code: result.error } });
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

  /** Internal entry for the bus bridge: `cycle.opened` requires a new signed contract. */
  app.post("/events/cycle-opened", async (req, reply) => {
    const parsed = parseEvent(req.body);
    if (!parsed.success || parsed.data.type !== "cycle.opened") {
      return reply.code(400).send({ ok: false, error: { code: "rules.invalid_event" } });
    }
    const payload = parsed.data.payload as EventPayload<"cycle.opened">;
    const { cycleId, firstDay } = payload;
    cycleContracts.onCycleOpened(parsed.data.userId, { cycleId, firstDay });
    return { ok: true, data: { cycleId } };
  });

  app.get("/contracts/status", async (req, reply) => {
    const userId = req.headers["x-user-id"];
    if (typeof userId !== "string" || userId === "") {
      return reply.code(401).send({ ok: false, error: { code: "unauthorized" } });
    }
    const now = (deps.now ?? (() => new Date()))();
    return { ok: true, data: cycleContracts.status(userId, now) ?? null };
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
