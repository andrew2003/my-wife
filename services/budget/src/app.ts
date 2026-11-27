import { randomUUID } from "node:crypto";
import type { AppConfig } from "@my-wife/config";
import {
  ApprovePlanRequestSchema,
  SubmitBalanceSnapshotRequestSchema,
  type EventEnvelope,
  type SettingKey,
} from "@my-wife/contracts";
import { createBalanceCheck, MemoryBalanceSnapshotStore } from "./balance-check";
import { createServiceApp, type ServiceDeps } from "@my-wife/service-kit";
import { createReceiptHandler } from "./accounts";
import { createBankEventHandler } from "./bank-event-wiring";
import { createForeignCardHandler } from "./foreign-card";
import { createPenaltySavingsWithdrawalHandler } from "./penalty-savings-withdrawal";
import { createRefundTransferHandler } from "./refund-wiring";
import { buildFundRequests, createContractSignedHandler, createCycleApprover } from "./approval";
import { createFundingHandler } from "./funding";
import { buildTransferQr, type TransferQrOptions } from "./transfer-qr";
import { createTransactionHandler } from "./transactions";
import {
  createPlanPublisher,
  createWeekPlannedHandler,
  parsePublishWeeklyPlanRequest,
} from "./plan-publish";
import { createWeekClosedHandler } from "./overspend";
import { createExceptionClaimer } from "./exceptions";
import { createDebtOpener, toDebt } from "./debts";
import {
  createWishlist,
  MemoryWishlistStore,
  readWishlistPool,
  type WishlistStore,
} from "./wishlist";
import {
  createWeeklyMenuService,
  MemoryWeeklyMenuStore,
  type WeeklyMenuStore,
} from "./weekly-menu";
import {
  createGroupExpenseRecorder,
  createIncomeRecorder,
  incomePoolTotalVnd,
} from "./income-pool";
import { buildOverview, roundingFrom } from "./overview";
import {
  createUnknownDeadlineJob,
  createUnknownSpendHandlers,
  type UnknownSpendDeps,
} from "./unknown-spend";
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
  wishlistStore?: WishlistStore;
  weeklyMenuStore?: WeeklyMenuStore;
  totalVnd?: (userId: string) => number | undefined;
  /** Reads the facts of an unknown receipt from ingest (`receipt.unknown` has no amount). */
  readReceipt?: UnknownSpendDeps["readReceipt"];
  /** Overrides of the QR memo limit and service code (defaults live in transfer-qr.ts). */
  qrOptions?: TransferQrOptions;
  /** Bank and account number to pay into; budget accounts hold no bank number (decisions.md). */
  readBankDestination?: (
    userId: string,
    bankAccountId: string,
  ) => Promise<{ bankBin: string; accountNumber: string } | undefined>;
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
  const detectPenaltyWithdrawal = createPenaltySavingsWithdrawalHandler({
    store,
    publish: deps.publish ?? (() => undefined),
  });
  app.decorate("onReceiptParsed", async (event: EventEnvelope) => {
    await confirmAccount(event);
    await fundAccount(event);
    await recordTransaction(event);
    await recordBankEvent(event);
    await recordForeignCard(event);
    await recordRefundOrTransfer(event);
    await detectPenaltyWithdrawal(event);
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
  const unknownDeadline = createUnknownDeadlineJob({
    store,
    newId: randomUUID,
    publish: deps.publish ?? (() => undefined),
  });
  // Internal job (the gateway forwards only /budget paths): books overdue unknown spend of a user.
  app.post("/jobs/unknown-deadline", async (req, reply) => {
    const userId = (req.body as { userId?: unknown } | null)?.userId;
    if (typeof userId !== "string" || userId === "") {
      return reply.code(400).send({ ok: false, error: { code: "invalid_request" } });
    }
    return { ok: true, data: await unknownDeadline.run(userId, now()) };
  });
  app.decorate("onReceiptUnknown", unknownSpend.onReceiptUnknown);
  app.decorate("onReplyReceived", unknownSpend.onReplyReceived);
  app.decorate("onContractSigned", createContractSignedHandler({ store }));
  app.decorate(
    "onWeekClosed",
    createWeekClosedHandler({
      store,
      now,
      newId: randomUUID,
      publish: deps.publish ?? (() => undefined),
      readSettings: deps.readSettings,
    }),
  );
  const debts = createDebtOpener({
    store,
    now,
    newId: randomUUID,
    publish: deps.publish ?? (() => undefined),
    readSettings: deps.readSettings,
  });
  // Debt ledger (spec 10 section 6): list, and open a loan to a friend or a borrow.
  app.get("/budget/debts", async (req, reply) => {
    const userId = req.headers["x-user-id"];
    if (typeof userId !== "string" || userId === "") {
      return reply.code(401).send({ ok: false, error: { code: "unauthorized" } });
    }
    const record = await store.find(userId);
    return { ok: true, data: { debts: (record?.debts ?? []).map(toDebt) } };
  });
  app.post("/budget/debts", async (req, reply) => {
    const userId = req.headers["x-user-id"];
    if (typeof userId !== "string" || userId === "") {
      return reply.code(401).send({ ok: false, error: { code: "unauthorized" } });
    }
    const result = await debts.open(userId, req.body);
    if (!result.ok) {
      return reply.code(result.error.code === "budget.cycle_not_found" ? 404 : 400).send(result);
    }
    return reply.code(201).send(result);
  });

  // Wishlist (spec 10 section 10): items with progress from the future-purchases savings.
  const wishlist = createWishlist({
    store: deps.wishlistStore ?? new MemoryWishlistStore(),
    now,
    newId: randomUUID,
    readPool: async (userId) => readWishlistPool(await store.find(userId)),
  });
  app.get("/budget/wishlist", async (req, reply) => {
    const userId = req.headers["x-user-id"];
    if (typeof userId !== "string" || userId === "") {
      return reply.code(401).send({ ok: false, error: { code: "unauthorized" } });
    }
    return wishlist.list(userId);
  });
  app.post("/budget/wishlist", async (req, reply) => {
    const userId = req.headers["x-user-id"];
    if (typeof userId !== "string" || userId === "") {
      return reply.code(401).send({ ok: false, error: { code: "unauthorized" } });
    }
    const result = await wishlist.add(userId, req.body);
    return reply.code(result.ok ? 201 : 400).send(result);
  });
  app.post("/budget/wishlist/:id/bought", async (req, reply) => {
    const userId = req.headers["x-user-id"];
    if (typeof userId !== "string" || userId === "") {
      return reply.code(401).send({ ok: false, error: { code: "unauthorized" } });
    }
    const result = await wishlist.markBought(userId, (req.params as { id: string }).id);
    if (result.ok) return result;
    const code = result.error.code;
    return reply.code(code === "budget.wishlist_item_not_found" ? 404 : 409).send(result);
  });

  // Weekly menu and shopping list (spec 10 section 4): code fits the estimate to the food limit.
  const weeklyMenu = createWeeklyMenuService({
    store,
    menus: deps.weeklyMenuStore ?? new MemoryWeeklyMenuStore(),
    now,
    readSettings: deps.readSettings,
  });
  const menuStatus = (code: string) =>
    code === "budget.cycle_not_found" || code === "budget.menu_not_found" ? 404 : 400;
  app.post("/budget/weekly-menu", async (req, reply) => {
    const userId = req.headers["x-user-id"];
    if (typeof userId !== "string" || userId === "") {
      return reply.code(401).send({ ok: false, error: { code: "unauthorized" } });
    }
    const result = await weeklyMenu.generate(userId, req.body);
    return reply.code(result.ok ? 201 : menuStatus(result.error.code)).send(result);
  });
  app.get("/budget/weekly-menu", async (req, reply) => {
    const userId = req.headers["x-user-id"];
    if (typeof userId !== "string" || userId === "") {
      return reply.code(401).send({ ok: false, error: { code: "unauthorized" } });
    }
    const weekIndex = Number((req.query as { weekIndex?: string }).weekIndex);
    if (!Number.isSafeInteger(weekIndex) || weekIndex < 1) {
      return reply.code(400).send({ ok: false, error: { code: "invalid_request" } });
    }
    const result = await weeklyMenu.get(userId, weekIndex);
    return result.ok ? result : reply.code(menuStatus(result.error.code)).send(result);
  });

  // Shared expenses and the income pool (spec 10 section 6).
  const poolDeps = {
    store,
    now,
    newId: randomUUID,
    publish: deps.publish ?? (() => undefined),
    readSettings: deps.readSettings,
  };
  const groupExpenses = createGroupExpenseRecorder(poolDeps);
  const incomeRecorder = createIncomeRecorder(poolDeps);
  app.post("/budget/group-expenses", async (req, reply) => {
    const userId = req.headers["x-user-id"];
    if (typeof userId !== "string" || userId === "") {
      return reply.code(401).send({ ok: false, error: { code: "unauthorized" } });
    }
    const result = await groupExpenses.record(userId, req.body);
    if (!result.ok) {
      return reply.code(result.error.code === "budget.cycle_not_found" ? 404 : 400).send(result);
    }
    return reply.code(201).send(result);
  });
  app.get("/budget/income-pool", async (req, reply) => {
    const userId = req.headers["x-user-id"];
    if (typeof userId !== "string" || userId === "") {
      return reply.code(401).send({ ok: false, error: { code: "unauthorized" } });
    }
    const record = await store.find(userId);
    const entries = record?.incomePool ?? [];
    return {
      ok: true,
      data: {
        totalVnd: incomePoolTotalVnd(entries),
        entries: entries.map((e) => ({
          id: e.id,
          amountVnd: e.amountVnd,
          payer: e.payer,
          receivedAt: e.receivedAt,
          allocatedCycleId: e.allocatedCycleId,
        })),
      },
    };
  });
  app.post("/budget/income", async (req, reply) => {
    const userId = req.headers["x-user-id"];
    if (typeof userId !== "string" || userId === "") {
      return reply.code(401).send({ ok: false, error: { code: "unauthorized" } });
    }
    const result = await incomeRecorder.record(userId, req.body);
    if (!result.ok) {
      return reply.code(result.error.code === "budget.cycle_not_found" ? 404 : 400).send(result);
    }
    return reply.code(201).send(result);
  });

  // Exceptions (spec 10 section 8): claimed before the week closes, funded from the contingency
  // fund at close.
  const claimException = createExceptionClaimer({
    store,
    now,
    newId: randomUUID,
    readSettings: deps.readSettings,
  });
  const EXCEPTION_STATUS: Record<string, number> = {
    "budget.cycle_not_found": 404,
    "budget.category_not_found": 404,
    "budget.cycle_not_running": 409,
    "budget.week_not_open": 409,
    "budget.exception_already_claimed": 409,
    "budget.exception_limit_reached": 409,
    "budget.exception_not_allowed": 400,
  };
  app.post("/budget/exceptions", async (req, reply) => {
    const userId = req.headers["x-user-id"];
    if (typeof userId !== "string" || userId === "") {
      return reply.code(401).send({ ok: false, error: { code: "unauthorized" } });
    }
    const body = req.body as { categoryId?: unknown; weekIndex?: unknown } | null;
    const weekIndex = body?.weekIndex;
    if (
      typeof body?.categoryId !== "string" ||
      body.categoryId === "" ||
      (weekIndex !== undefined && (!Number.isInteger(weekIndex) || (weekIndex as number) < 1))
    ) {
      return reply.code(400).send({ ok: false, error: { code: "invalid_request" } });
    }
    const result = await claimException(userId, {
      categoryId: body.categoryId,
      weekIndex: weekIndex as number | undefined,
    });
    if (!result.ok) return reply.code(EXCEPTION_STATUS[result.error.code] ?? 400).send(result);
    return reply.code(201).send(result);
  });

  // Weekly balance check (spec 10 section 9): the user submits the balance of each account.
  const balanceCheck = createBalanceCheck({
    store,
    snapshots: new MemoryBalanceSnapshotStore(),
    publish: deps.publish ?? (() => undefined),
    readSettings: deps.readSettings,
  });
  app.post("/budget/balance-snapshots", async (req, reply) => {
    const userId = req.headers["x-user-id"];
    if (typeof userId !== "string" || userId === "") {
      return reply.code(401).send({ ok: false, error: { code: "unauthorized" } });
    }
    const parsed = SubmitBalanceSnapshotRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: { code: "invalid_request" } });
    }
    return { ok: true, data: await balanceCheck.run(userId, [parsed.data], now()) };
  });

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
    const accounts: FundingAccountView[] = [];
    for (const t of transfers) {
      const account = record.accounts.find((a) => a.id === t.bankAccountId)!;
      const destination = await deps.readBankDestination?.(userId, t.bankAccountId);
      accounts.push({
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
        ...(destination && t.requiredVnd > 0
          ? {
              qrPayload: buildTransferQr(
                { ...destination, amountVnd: t.requiredVnd, memo: t.memo },
                deps.qrOptions,
              ),
            }
          : {}),
      });
    }
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
  /** VietQR payload with account, amount and transfer code; absent without a bank destination. */
  qrPayload?: string;
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
