import type { AppConfig } from "@my-wife/config";
import { PushSubscriptionRequestSchema } from "@my-wife/contracts";
import { createServiceApp, type ServiceDeps } from "@my-wife/service-kit";
import { InvalidPushEndpointError, type PushService } from "./push/push-service";

export const SERVICE_NAME = "notify";

export type NotifyDeps = ServiceDeps & {
  /** Web push; routes are mounted only when given. */
  push?: PushService;
};

const UnsubscribeSchema = PushSubscriptionRequestSchema.pick({ endpoint: true });

/** Factory used by main.ts, the dev runner and tests; no process-level globals (ADR 0007). */
export function createApp(config: AppConfig, deps: NotifyDeps = {}) {
  const app = createServiceApp({
    name: SERVICE_NAME,
    logLevel: config.logLevel,
    nats: deps.nats,
  });
  const push = deps.push;
  if (push) {
    const userOf = (header: unknown) => (typeof header === "string" && header ? header : null);

    app.post("/push/subscriptions", async (req, reply) => {
      const userId = userOf(req.headers["x-user-id"]);
      if (!userId)
        return reply.code(401).send({ ok: false, error: { code: "notify.unauthorized" } });
      const parsed = PushSubscriptionRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ ok: false, error: { code: "notify.invalid_subscription" } });
      }
      try {
        const { id } = await push.subscribe(userId, parsed.data);
        return reply.code(201).send({ ok: true, data: { id } });
      } catch (err) {
        if (err instanceof InvalidPushEndpointError) {
          return reply
            .code(400)
            .send({ ok: false, error: { code: "notify.invalid_subscription" } });
        }
        throw err;
      }
    });

    app.delete("/push/subscriptions", async (req, reply) => {
      const userId = userOf(req.headers["x-user-id"]);
      if (!userId)
        return reply.code(401).send({ ok: false, error: { code: "notify.unauthorized" } });
      const parsed = UnsubscribeSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ ok: false, error: { code: "notify.invalid_subscription" } });
      }
      await push.unsubscribe(userId, parsed.data.endpoint);
      return reply.code(204).send();
    });
  }
  return app;
}
