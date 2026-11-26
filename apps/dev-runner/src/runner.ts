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
import { createApp as rules } from "@my-wife/rules";
import { createApp as schedule } from "@my-wife/schedule";
import { createApp as sync } from "@my-wife/sync";

const FACTORIES: Record<ServiceName, CreateApp> = {
  gateway, identity, budget, ingest, schedule, monitor, rules, ai, notify, sync,
};

export type Runner = {
  urls: Record<ServiceName, string>;
  stop(): Promise<void>;
};

export type RunnerOptions = {
  /** Let the OS pick ports (tests). */
  ephemeralPorts?: boolean;
  deps?: ServiceDeps;
};

/** Mounts the ten services in this one Node process (ADR 0007). */
export async function startAll(config: AppConfig, opts: RunnerOptions = {}): Promise<Runner> {
  const apps: FastifyInstance[] = [];
  const urls = {} as Record<ServiceName, string>;
  try {
    for (const name of SERVICE_NAMES) {
      const app = await FACTORIES[name](config, opts.deps);
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
    stop: async () => {
      await Promise.all(apps.map((a) => a.close()));
    },
  };
}
