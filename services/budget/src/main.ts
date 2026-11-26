import { loadConfig, servicePort } from "@my-wife/config";
import { parseEvent, type EventEnvelope } from "@my-wife/contracts";
import { connectNats, subject } from "@my-wife/service-kit";
import { createApp, SERVICE_NAME } from "./app";

const config = loadConfig(process.env);
const nats = await connectNats(config.natsUrl, SERVICE_NAME);
const prefix = config.natsSubjectPrefix;
const app = await createApp(config, {
  nats,
  publish: (event: EventEnvelope) => {
    nats.publish(subject(prefix, event.type), JSON.stringify(event));
  },
});

// Consume onboarding.step_completed; payloads are validated against the contracts first.
const sub = nats.subscribe(subject(prefix, "onboarding.step_completed"));
void (async () => {
  for await (const msg of sub) {
    try {
      const parsed = parseEvent(JSON.parse(msg.string()));
      if (!parsed.success) {
        app.log.warn({ error: parsed.error }, "dropped invalid onboarding event");
        continue;
      }
      await app.onOnboardingStepCompleted(parsed.data);
    } catch (err) {
      app.log.error({ err }, "onboarding handler failed");
    }
  }
})();

await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? servicePort(SERVICE_NAME)) });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void app.close().then(() => nats.drain());
  });
}
