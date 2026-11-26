import type { FastifyInstance } from "fastify";
import { servicePort, type AppConfig } from "@my-wife/config";
import { SERVICE_NAMES, type ServiceName } from "@my-wife/contracts";
import type { CreateApp, ServiceDeps } from "@my-wife/service-kit";
import { createApp as ai } from "@my-wife/ai";
import { createApp as budget } from "@my-wife/budget";
import { createApp as gateway } from "@my-wife/gateway";
import { createApp as identity } from "@my-wife/identity";
import { createApp as ingest } from "@my-wife/ingest";
import { createApp as monitor } from "@my-wife/monitor";
import { createApp as notify } from "@my-wife/notify";
import { createApp as rules, type RulesDeps } from "@my-wife/rules";
import { createApp as schedule, type ScheduleDeps } from "@my-wife/schedule";
import { createApp as sync } from "@my-wife/sync";

type ScheduleApp = Awaited<ReturnType<typeof schedule>>;

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
  stop(): Promise<void>;
};

export type RunnerOptions = {
  /** Let the OS pick ports (tests). */
  ephemeralPorts?: boolean;
  deps?: ServiceDeps;
  /** Extra dependencies for the rules service (publisher, stores, settings reader). */
  rules?: RulesDeps;
  /** Extra dependencies for the schedule service (publisher, clock, settings reader). */
  schedule?: ScheduleDeps;
};

/** Mounts the ten services in this one Node process (ADR 0007). */
export async function startAll(config: AppConfig, opts: RunnerOptions = {}): Promise<Runner> {
  const apps: FastifyInstance[] = [];
  const urls = {} as Record<ServiceName, string>;
  let trialJob: ((now: Date) => Promise<void>) | undefined;
  let sessionJob: ((now: Date) => Promise<unknown>) | undefined;
  try {
    for (const name of SERVICE_NAMES) {
      const extra = name === "rules" ? opts.rules : name === "schedule" ? opts.schedule : undefined;
      const deps = extra ? { ...opts.deps, ...extra } : opts.deps;
      const app = await FACTORIES[name](config, deps);
      if (name === "rules") trialJob = app.runTrialJob;
      if (name === "schedule") sessionJob = (app as unknown as ScheduleApp).runSessionJob;
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
