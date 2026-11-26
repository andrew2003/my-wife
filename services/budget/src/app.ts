import { randomUUID } from "node:crypto";
import type { AppConfig } from "@my-wife/config";
import type { EventEnvelope, SettingKey } from "@my-wife/contracts";
import { createServiceApp, type ServiceDeps } from "@my-wife/service-kit";
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
  const onOnboardingStepCompleted = createOnboardingHandler({
    store: deps.store ?? new MemorySampleBudgetStore(),
    locale: config.uiLanguage,
    now: deps.now ?? (() => new Date()),
    newId: randomUUID,
    publish: deps.publish ?? (() => undefined),
    readSettings: deps.readSettings,
    totalVnd: deps.totalVnd,
  });
  // Event consumers are wired by main.ts (NATS) and the dev runner.
  app.decorate("onOnboardingStepCompleted", onOnboardingStepCompleted);
  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    /** Consumer of `onboarding.step_completed`; wired to NATS by main.ts. */
    onOnboardingStepCompleted: (event: EventEnvelope) => Promise<void>;
  }
}
