import { randomUUID } from "node:crypto";
import type { AppConfig } from "@my-wife/config";
import { ApprovePlanRequestSchema, type EventEnvelope, type SettingKey } from "@my-wife/contracts";
import { createServiceApp, type ServiceDeps } from "@my-wife/service-kit";
import { createReceiptHandler } from "./accounts";
import { createContractSignedHandler, createCycleApprover } from "./approval";
import { createFundingHandler } from "./funding";
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
  app.decorate("onReceiptParsed", async (event: EventEnvelope) => {
    await confirmAccount(event);
    await fundAccount(event);
  });
  app.decorate("onContractSigned", createContractSignedHandler({ store }));

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
  app.post("/cycles/approve", async (req, reply) => {
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
  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    /** Consumer of `onboarding.step_completed`; wired to NATS by main.ts. */
    onOnboardingStepCompleted: (event: EventEnvelope) => Promise<void>;
    /** Consumer of `receipt.parsed`; confirms the account the receipt resolves to. */
    onReceiptParsed: (event: EventEnvelope) => Promise<void>;
    /** Consumer of `contract.signed`; records the contract the approval guard checks. */
    onContractSigned: (event: EventEnvelope) => Promise<void>;
  }
}
