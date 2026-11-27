import { randomUUID } from "node:crypto";
import type { AppConfig } from "@my-wife/config";
import { ApprovePlanRequestSchema, type EventEnvelope, type SettingKey } from "@my-wife/contracts";
import { createServiceApp, type ServiceDeps } from "@my-wife/service-kit";
import { createReceiptHandler } from "./accounts";
import { createBankEventHandler } from "./bank-event-wiring";
import { createForeignCardHandler } from "./foreign-card";
import { createRefundTransferHandler } from "./refund-wiring";
import { buildFundRequests, createContractSignedHandler, createCycleApprover } from "./approval";
import { createFundingHandler } from "./funding";
import { createTransactionHandler } from "./transactions";
import {
  createPlanPublisher,
  createWeekPlannedHandler,
  parsePublishWeeklyPlanRequest,
} from "./plan-publish";
import { createWeekClosedHandler } from "./overspend";
import { buildOverview, roundingFrom } from "./overview";
import { createUnknownSpendHandlers, type UnknownSpendDeps } from "./unknown-spend";
import {
  createOnboardingHandler,
  MemorySampleBudgetStore,
  type SampleBudgetStore,
} from "./onboarding";

export const SERVICE_NAME = "budget";

export type BudgetDeps = ServiceDeps & {
  store?: SampleBudgetStore;
  /** Time is a parameter so tests can simulate it. */
  now?: () => Date;
  readSettings?: (userId: string) => Promise<Partial<Record<SettingKey, unknown>>>;
  publish?: (event: EventEnvelope) => void | Promise<void>;
  totalVnd?: (userId: string) => number | undefined;
  /** Reads the facts of an unknown receipt from ingest (`receipt.unknown` has no amount). */
  readReceipt?: UnknownSpendDeps["readReceipt"];
};

/** Factory used by main.ts, the dev runner and tests; no process-level globals (ADR 0007). */
export function createApp(config: AppConfig, deps: BudgetDeps = {}) {
  const app = createServiceApp({
    name: SERVICE_NAME,
    logLevel: config.logLevel,
    nats: deps.nats,
  });
  const store = deps.store ?? new MemorySampleBudgetStore();
  const now = deps.now ?? (() => new Date());
  const onOnboardingStepCompleted = createOnboardingHandler({
    store,
    locale: config.uiLanguage,
    now,
    newId: randomUUID,
    publish: deps.publish ?? (() => undefined),
    readSettings: deps.readSettings,
    totalVnd: deps.totalVnd,
  });
  // Event consumers are wired by main.ts (NATS) and the dev runner.
  app.decorate("onOnboardingStepCompleted", onOnboardingStepCompleted);
  const confirmAccount = createReceiptHandler({ store, now });
  const fundAccount = createFundingHandler({
    store,
    now,
    publish: deps.publish ?? (() => undefined),
  });
  const recordTransaction = createTransactionHandler({
    store,
    now,
    newId: randomUUID,
    publish: deps.publish ?? (() => undefined),
    readSettings: deps.readSettings,
  });
  const recordBankEvent = createBankEventHandler({
    store,
    locale: config.uiLanguage,
    now,
    newId: randomUUID,
    publish: deps.publish ?? (() => undefined),
    readSettings: deps.readSettings,
  });
  const recordForeignCard = createForeignCardHandler({
    store,
    now,
    newId: randomUUID,
    publish: deps.publish ?? (() => undefined),
  });
  const recordRefundOrTransfer = createRefundTransferHandler({
    store,
    now,
    newId: randomUUID,
    publish: deps.publish ?? (() => undefined),
    readSettings: deps.readSettings,
  });
  app.decorate("onReceiptParsed", async (event: EventEnvelope) => {
    await confirmAccount(event);
    await fundAccount(event);
    await recordTransaction(event);
    await recordBankEvent(event);
    await recordForeignCard(event);
    await recordRefundOrTransfer(event);
  });
  const unknownSpend = createUnknownSpendHandlers({
    store,
    now,
    newId: randomUUID,
    publish: deps.publish ?? (() => undefined),
    // Without an ingest reader the receipt facts are unknown and nothing is opened.
    readReceipt: deps.readReceipt ?? (async () => undefined),
    readSettings: deps.readSettings,
  });
  app.decorate("onReceiptUnknown", unknownSpend.onReceiptUnknown);
  app.decorate("onReplyReceived", unknownSpend.onReplyReceived);
  app.decorate("onContractSigned", createContractSignedHandler({ store }));
  app.decorate(
    "onWeekClosed",
    createWeekClosedHandler({
      store,
      now,
      publish: deps.publish ?? (() => undefined),
      readSettings: deps.readSettings,
    }),
  );

  app.decorate(
    "onWeekPlanned",
    createWeekPlannedHandler({
      store,
      now,
      publish: deps.publish ?? (() => undefined),
    }),
  );

  const approveCycle = createCycleApprover({
    store,
    now,
    publish: deps.publish ?? (() => undefined),
  });
  const STATUS: Record<string, number> = {
    "budget.cycle_not_found": 404,
    "budget.cycle_not_draft": 409,
    "budget.contract_not_signed": 409,
    "budget.account_unconfirmed": 409,
  };
  // The gateway has verified the session and forwards the user id (see decisions.md).
  app.post("/budget/cycles/approve", async (req, reply) => {
    const userId = req.headers["x-user-id"];
    if (typeof userId !== "string" || userId === "") {
      return reply.code(401).send({ ok: false, error: { code: "unauthorized" } });
    }
    const body = ApprovePlanRequestSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: { code: "invalid_request" } });
    }
    const result = await approveCycle({ userId, ...body.data });
    if (!result.ok) return reply.code(STATUS[result.error.code] ?? 400).send(result);
    return result;
  });
  const publishPlan = createPlanPublisher({
    store,
    now,
    publish: deps.publish ?? (() => undefined),
  });
  const PLAN_STATUS: Record<string, number> = {
    "budget.cycle_not_found": 404,
    "budget.category_not_found": 404,
    "budget.cycle_not_running": 409,
    "budget.week_already_published": 409,
  };
  // Internal write route: the weekly plan's planned items enter the budget record here.
  app.post("/budget/weekly-plan", async (req, reply) => {
    const userId = req.headers["x-user-id"];
    if (typeof userId !== "string" || userId === "") {
      return reply.code(401).send({ ok: false, error: { code: "unauthorized" } });
    }
    const body = parsePublishWeeklyPlanRequest(req.body);
    if (!body) {
      return reply.code(400).send({ ok: false, error: { code: "invalid_request" } });
    }
    const result = await publishPlan({ userId, ...body });
    if (!result.ok) return reply.code(PLAN_STATUS[result.error.code] ?? 400).send(result);
    return result;
  });
  // Read route for the onboarding review; the path keeps the gateway's `/budget` prefix.
  app.get("/budget/sample-cycle", async (req, reply) => {
    const userId = req.headers["x-user-id"];
    if (typeof userId !== "string" || userId === "") {
      return reply.code(401).send({ ok: false, error: { code: "unauthorized" } });
    }
    const record = await store.find(userId);
    if (!record) {
      return reply.code(404).send({ ok: false, error: { code: "budget.cycle_not_found" } });
    }
    return { ok: true, data: { cycle: record.cycle, categories: record.categories } };
  });
  // Read route for the budget page; the response schema is `BudgetOverviewResponse` (ADR 0012).
  app.get("/budget/overview", async (req, reply) => {
    const userId = req.headers["x-user-id"];
    if (typeof userId !== "string" || userId === "") {
      return reply.code(401).send({ ok: false, error: { code: "unauthorized" } });
    }
    const record = await store.find(userId);
    if (!record) {
      return reply.code(404).send({ ok: false, error: { code: "budget.cycle_not_found" } });
    }
    const settings = (await deps.readSettings?.(userId)) ?? {};
    return { ok: true, data: buildOverview(record, now(), roundingFrom(settings)) };
  });
  // Read route for the funding screen. There is no contract response schema yet (ADR needed),
  // so the shape is defined locally; it follows the web's expectation (decisions.md, MW-022).
  app.get("/budget/funding", async (req, reply) => {
    const userId = req.headers["x-user-id"];
    if (typeof userId !== "string" || userId === "") {
      return reply.code(401).send({ ok: false, error: { code: "unauthorized" } });
    }
    const record = await store.find(userId);
    if (!record) {
      return reply.code(404).send({ ok: false, error: { code: "budget.cycle_not_found" } });
    }
    if (record.cycle.state !== "awaiting_funds") {
      return reply
        .code(409)
        .send({ ok: false, error: { code: "budget.cycle_not_awaiting_funds" } });
    }
    const transfers = buildFundRequests({
      sequence: record.cycle.sequence,
      accounts: record.accounts,
      categories: record.categories,
    });
    const accounts: FundingAccountView[] = transfers.map((t) => {
      const account = record.accounts.find((a) => a.id === t.bankAccountId)!;
      return {
        bankAccountId: t.bankAccountId,
        name: account.name,
        code: account.code,
        requiredVnd: t.requiredVnd,
        memo: t.memo,
        // Same rule as the cycle opening: nothing to transfer, or a receipt covering the amount.
        funded:
          t.requiredVnd === 0 ||
          record.fundings.some(
            (f) => f.bankAccountId === t.bankAccountId && f.amountVnd >= t.requiredVnd,
          ),
      };
    });
    return { ok: true, data: { cycle: record.cycle, accounts } };
  });
  return app;
}

/** Local response type of `GET /budget/funding`; contracts have none yet. */
export interface FundingAccountView {
  bankAccountId: string;
  name: string;
  code: string;
  requiredVnd: number;
  memo: string;
  funded: boolean;
}

declare module "fastify" {
  interface FastifyInstance {
    /** Consumer of `onboarding.step_completed`; wired to NATS by main.ts. */
    onOnboardingStepCompleted: (event: EventEnvelope) => Promise<void>;
    /** Consumer of `receipt.parsed`; confirms the account the receipt resolves to. */
    onReceiptParsed: (event: EventEnvelope) => Promise<void>;
    /** Consumer of `receipt.unknown`; opens an anomaly and asks for a category. */
    onReceiptUnknown: (event: EventEnvelope) => Promise<void>;
    /** Consumer of `notify.reply_received`; books the answered anomaly. */
    onReplyReceived: (event: EventEnvelope) => Promise<void>;
    /** Consumer of `contract.signed`; records the contract the approval guard checks. */
    onContractSigned: (event: EventEnvelope) => Promise<void>;
    /** Consumer of `week.closed`; detects overspending once per week. */
    onWeekClosed: (event: EventEnvelope) => Promise<void>;
    /** Consumer of `week.planned`; publishes the approved planned items of the week. */
    onWeekPlanned: (event: EventEnvelope) => Promise<void>;
  }
}
