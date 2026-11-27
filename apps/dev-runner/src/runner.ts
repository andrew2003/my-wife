import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { servicePort, type AppConfig } from "@my-wife/config";
import { SERVICE_NAMES, SETTINGS, type EventEnvelope, type ServiceName } from "@my-wife/contracts";
import type { CreateApp, ServiceDeps } from "@my-wife/service-kit";
import { createApp as ai } from "@my-wife/ai";
import { createApp as budget, type BudgetDeps } from "@my-wife/budget";
import { createApp as gateway } from "@my-wife/gateway";
import { createApp as identity, type IdentityDeps } from "@my-wife/identity";
import {
  createApp as ingest,
  createMailauthVerifier,
  MemoryIngestStore,
  type IngestDeps,
} from "@my-wife/ingest";
import { createApp as monitor, type MonitorServiceDeps } from "@my-wife/monitor";
import { createApp as notify } from "@my-wife/notify";
import { createApp as rules, type RulesDeps } from "@my-wife/rules";
import { createApp as schedule, createSettingsReader, type ScheduleDeps } from "@my-wife/schedule";
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
  /** Routes an event to its in-process consumers, as the bus would (also used by tests). */
  publish(event: EventEnvelope): Promise<void>;
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
  /** Extra dependencies for the budget service (store, settings reader, receipt reader). */
  budget?: BudgetDeps;
  /** Extra dependencies for the ai service (publisher, clock, vision model, settings reader). */
  ai?: Parameters<typeof ai>[1];
  /**
   * The ingest webhook is always mounted. Everything is in memory unless given here: an empty
   * sender map and template list, a user resolver that knows nobody, the real DKIM verifier and
   * a random webhook secret (or `INGEST_WEBHOOK_SECRET`).
   */
  ingest?: Partial<IngestDeps>;
  /** Called with every event routed in process, before delivery (tests, tracing). */
  onEvent?: (event: EventEnvelope) => void;
  /** Called after a consumer service has handled an event. */
  onDelivered?: (service: "budget" | "rules" | "schedule", event: EventEnvelope) => void;
};

/** Mounts the ten services in this one Node process (ADR 0007). */
export async function startAll(config: AppConfig, opts: RunnerOptions = {}): Promise<Runner> {
  const apps: FastifyInstance[] = [];
  const urls = {} as Record<ServiceName, string>;
  let trialJob: ((now: Date) => Promise<void>) | undefined;
  let sessionJob: ((now: Date) => Promise<unknown>) | undefined;
  let sleepJob: ((now: Date) => Promise<unknown>) | undefined;
  let gapCheck: ((now: Date) => Promise<unknown>) | undefined;
  let budgetApp: BudgetApp | undefined;
  const post = async (url: string, event: EventEnvelope, service: string) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });
    if (!res.ok) throw new Error(`${service} rejected ${event.type}: ${res.status}`);
  };
  /**
   * In-process stand-in for the NATS delivery each service main.ts sets up: events a service
   * publishes reach the consumers directly, with the same envelope the bus would carry.
   */
  const deliver = async (event: EventEnvelope): Promise<void> => {
    opts.onEvent?.(event);
    const to = (service: "budget" | "rules" | "schedule", run: () => Promise<void> | undefined) =>
      Promise.resolve(run()).then(() => opts.onDelivered?.(service, event));
    const jobs: Array<Promise<void>> = [];
    switch (event.type) {
      case "onboarding.step_completed":
        jobs.push(
          to("schedule", () =>
            post(`${urls.schedule}/events/onboarding-step-completed`, event, "schedule"),
          ),
          to("budget", () => budgetApp?.onOnboardingStepCompleted(event)),
        );
        break;
      case "receipt.parsed":
        jobs.push(
          to("budget", () => budgetApp?.onReceiptParsed(event)),
          to("rules", () => post(`${urls.rules}/events/receipt-parsed`, event, "rules")),
        );
        break;
      case "receipt.unknown":
        jobs.push(to("budget", () => budgetApp?.onReceiptUnknown(event)));
        break;
      case "notify.reply_received":
        jobs.push(to("budget", () => budgetApp?.onReplyReceived(event)));
        break;
      case "contract.signed":
        jobs.push(
          to("budget", () => budgetApp?.onContractSigned(event)),
          to("rules", () => post(`${urls.rules}/events/contract-signed`, event, "rules")),
        );
        break;
      case "week.closed":
        jobs.push(to("budget", () => budgetApp?.onWeekClosed(event)));
        break;
      case "week.planned":
        jobs.push(to("budget", () => budgetApp?.onWeekPlanned(event)));
        break;
      case "overspend.detected":
        jobs.push(
          to("rules", () => post(`${urls.rules}/events/overspend-detected`, event, "rules")),
        );
        break;
      default:
        return;
    }
    const results = await Promise.allSettled(jobs);
    const failed = results.find((r) => r.status === "rejected");
    if (failed) throw (failed as PromiseRejectedResult).reason;
  };
  /** Runs the service's own publisher, then routes the event in process. */
  const publishVia =
    (own?: (event: EventEnvelope) => void | Promise<void>) => async (event: EventEnvelope) => {
      await own?.(event);
      await deliver(event);
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
                : name === "budget"
                  ? opts.budget
                  : name === "ai"
                    ? opts.ai
                    : undefined;
      let deps: ServiceDeps | undefined = extra ? { ...opts.deps, ...extra } : opts.deps;
      if (name === "schedule") {
        // Identity starts before schedule; its URL is read lazily, per request.
        const own = opts.schedule?.readSettings;
        const stored = createSettingsReader(() => urls.identity);
        const withSettings: ScheduleDeps = { ...deps, readSettings: own ?? stored };
        deps = withSettings;
      }
      if (name === "identity") {
        const own = opts.identity?.publish;
        const withPublish: IdentityDeps = {
          ...deps,
          publish: publishVia(own),
        };
        deps = withPublish;
      }
      if (name === "budget") {
        const withPublish: BudgetDeps = { ...deps, publish: publishVia(opts.budget?.publish) };
        deps = withPublish;
      }
      if (name === "rules") {
        const withPublish: RulesDeps = { ...deps, publish: publishVia(opts.rules?.publish) };
        deps = withPublish;
      }
      if (name === "ingest") {
        const given = opts.ingest ?? {};
        const ingestDeps: IngestDeps = {
          store: given.store ?? new MemoryIngestStore(),
          verifyDkim: given.verifyDkim ?? createMailauthVerifier(),
          users: given.users ?? { resolve: async () => null },
          senderMap: given.senderMap ?? [],
          templates: given.templates ?? [],
          settings: given.settings ?? {
            maxEmailBytes: SETTINGS["ingest.max_email_bytes"].default,
            holdMatchWindowHours: SETTINGS["ingest.hold_match_window_hours"].default,
          },
          secret: given.secret ?? process.env.INGEST_WEBHOOK_SECRET ?? randomUUID(),
          now: given.now ?? (() => new Date()),
          newId: given.newId,
          publish: publishVia(given.publish),
        };
        deps = { ...deps, ingest: ingestDeps } as ServiceDeps;
      }
      const app = await FACTORIES[name](config, deps);
      if (name === "rules") trialJob = app.runTrialJob;
      if (name === "schedule") sessionJob = (app as unknown as ScheduleApp).runSessionJob;
      if (name === "schedule") sleepJob = (app as unknown as ScheduleApp).runSleepJob;
      if (name === "budget") budgetApp = app as unknown as BudgetApp;
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
    publish: deliver,
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
