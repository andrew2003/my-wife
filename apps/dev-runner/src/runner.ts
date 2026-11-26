import type { FastifyInstance } from "fastify";
import { servicePort, type AppConfig } from "@my-wife/config";
import { SERVICE_NAMES, type EventEnvelope, type ServiceName } from "@my-wife/contracts";
import type { CreateApp, ServiceDeps } from "@my-wife/service-kit";
import { createApp as ai } from "@my-wife/ai";
import { createApp as budget } from "@my-wife/budget";
import { createApp as gateway } from "@my-wife/gateway";
import { createApp as identity, type IdentityDeps } from "@my-wife/identity";
import { createApp as ingest } from "@my-wife/ingest";
import { createApp as monitor, type MonitorServiceDeps } from "@my-wife/monitor";
import { createApp as notify } from "@my-wife/notify";
import { createApp as rules, type RulesDeps } from "@my-wife/rules";
import { createApp as schedule, type ScheduleDeps } from "@my-wife/schedule";
import { createApp as sync } from "@my-wife/sync";

type ScheduleApp = Awaited<ReturnType<typeof schedule>>;
type MonitorApp = Awaited<ReturnType<typeof monitor>>;
type BudgetApp = Awaited<ReturnType<typeof budget>>;

const FACTORIES: Record<ServiceName, CreateApp> = {
  gateway,
  identity,
  budget,
  ingest,
  schedule,
  monitor,
  rules,
  ai,
  notify,
  sync,
};

export type Runner = {
  urls: Record<ServiceName, string>;
  /** Runs the rules trial job with an injected `now`; business code never reads the clock. */
  runTrialJob(now: Date): Promise<void>;
  /** Ends due work sessions with an injected `now`. */
  runSessionJob(now: Date): Promise<void>;
  /** Advances the bedtime state machines with an injected `now`. */
  runSleepJob(now: Date): Promise<void>;
  /** Checks missing heartbeats with an injected `now`. */
  runGapCheck(now: Date): Promise<void>;
  stop(): Promise<void>;
};

export type RunnerOptions = {
  /** Let the OS pick ports (tests). */
  ephemeralPorts?: boolean;
  deps?: ServiceDeps;
  /** Extra dependencies for the identity service (for example a pre-seeded store). */
  identity?: IdentityDeps;
  /** Extra dependencies for the rules service (publisher, stores, settings reader). */
  rules?: RulesDeps;
  /** Extra dependencies for the schedule service (publisher, clock, settings reader). */
  schedule?: ScheduleDeps;
  /** Extra dependencies for the monitor service (publisher, clock, settings reader, stores). */
  monitor?: MonitorServiceDeps;
};

/** Mounts the ten services in this one Node process (ADR 0007). */
export async function startAll(config: AppConfig, opts: RunnerOptions = {}): Promise<Runner> {
  const apps: FastifyInstance[] = [];
  const urls = {} as Record<ServiceName, string>;
  let trialJob: ((now: Date) => Promise<void>) | undefined;
  let sessionJob: ((now: Date) => Promise<unknown>) | undefined;
  let sleepJob: ((now: Date) => Promise<unknown>) | undefined;
  let gapCheck: ((now: Date) => Promise<unknown>) | undefined;
  let budgetHandler: ((event: EventEnvelope) => Promise<void>) | undefined;
  /**
   * In-process stand-in for the NATS delivery each service main.ts sets up: events identity
   * publishes reach the consumers directly, with the same envelope the bus would carry.
   */
  const deliver = async (event: EventEnvelope): Promise<void> => {
    if (event.type !== "onboarding.step_completed") return;
    const results = await Promise.allSettled([
      fetch(`${urls.schedule}/events/onboarding-step-completed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event),
      }).then((res) => {
        if (!res.ok) throw new Error(`schedule rejected ${event.type}: ${res.status}`);
      }),
      budgetHandler?.(event) ?? Promise.resolve(),
    ]);
    const failed = results.find((r) => r.status === "rejected");
    if (failed) throw (failed as PromiseRejectedResult).reason;
  };
  try {
    for (const name of SERVICE_NAMES) {
      const extra =
        name === "identity"
          ? opts.identity
          : name === "rules"
            ? opts.rules
            : name === "schedule"
              ? opts.schedule
              : name === "monitor"
                ? opts.monitor
                : undefined;
      let deps: ServiceDeps | undefined = extra ? { ...opts.deps, ...extra } : opts.deps;
      if (name === "identity") {
        const own = opts.identity?.publish;
        const withPublish: IdentityDeps = {
          ...deps,
          publish: async (event: EventEnvelope) => {
            await own?.(event);
            await deliver(event);
          },
        };
        deps = withPublish;
      }
      const app = await FACTORIES[name](config, deps);
      if (name === "rules") trialJob = app.runTrialJob;
      if (name === "schedule") sessionJob = (app as unknown as ScheduleApp).runSessionJob;
      if (name === "schedule") sleepJob = (app as unknown as ScheduleApp).runSleepJob;
      if (name === "budget") {
        budgetHandler = (app as unknown as BudgetApp).onOnboardingStepCompleted;
      }
      if (name === "monitor") gapCheck = (app as unknown as MonitorApp).runGapCheck;
      apps.push(app);
      await app.listen({ host: "127.0.0.1", port: opts.ephemeralPorts ? 0 : servicePort(name) });
      const address = app.server.address();
      const port = typeof address === "object" && address ? address.port : servicePort(name);
      urls[name] = `http://127.0.0.1:${port}`;
    }
  } catch (err) {
    await Promise.all(apps.map((a) => a.close()));
    throw err;
  }
  return {
    urls,
    runTrialJob: async (now) => {
      await trialJob?.(now);
    },
    runSessionJob: async (now) => {
      await sessionJob?.(now);
    },
    runSleepJob: async (now) => {
      await sleepJob?.(now);
    },
    runGapCheck: async (now) => {
      await gapCheck?.(now);
    },
    stop: async () => {
      await Promise.all(apps.map((a) => a.close()));
    },
  };
}

/** The part of the test-kit clock simulator the job needs. */
export interface JobClock {
  now(): Date;
  scheduleEvery(intervalMs: number, job: () => void | Promise<void>): number;
}

/** Runs the trial job on the shared clock; the job receives `now` from the simulator. */
export function mountTrialJob(runner: Runner, clock: JobClock, intervalMs: number): number {
  return clock.scheduleEvery(intervalMs, () => runner.runTrialJob(clock.now()));
}

/** Runs the session-end job on the shared clock; the job receives `now` from the simulator. */
export function mountSessionJob(runner: Runner, clock: JobClock, intervalMs: number): number {
  return clock.scheduleEvery(intervalMs, () => runner.runSessionJob(clock.now()));
}

/** Runs the heartbeat gap check on the shared clock; the job receives `now` from the simulator. */
export function mountGapCheckJob(runner: Runner, clock: JobClock, intervalMs: number): number {
  return clock.scheduleEvery(intervalMs, () => runner.runGapCheck(clock.now()));
}

/** Runs the bedtime reminder job on the shared clock; the job receives `now` from the simulator. */
export function mountSleepJob(runner: Runner, clock: JobClock, intervalMs: number): number {
  return clock.scheduleEvery(intervalMs, () => runner.runSleepJob(clock.now()));
}
