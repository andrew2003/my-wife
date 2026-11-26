import type { AppConfig } from "@my-wife/config";
import { createServiceApp, type ServiceDeps } from "@my-wife/service-kit";

export const SERVICE_NAME = "monitor";

/** Factory used by main.ts, the dev runner and tests; no process-level globals (ADR 0007). */
export function createApp(config: AppConfig, deps: ServiceDeps = {}) {
  const app = createServiceApp({
    name: SERVICE_NAME,
    logLevel: config.logLevel,
    nats: deps.nats,
  });
  // Register routes of this service below.
  return app;
}
