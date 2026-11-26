import type { FastifyInstance } from "fastify";
import type { AppConfig } from "@my-wife/config";

/** Every service package exports `createApp` with this shape (ADR 0007). */
export type CreateApp = (config: AppConfig, deps?: ServiceDeps) => FastifyInstance | Promise<FastifyInstance>;

export type ServiceDeps = {
  nats?: { isClosed(): boolean };
};
