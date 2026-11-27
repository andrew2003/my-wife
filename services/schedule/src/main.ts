import { loadConfig, servicePort } from "@my-wife/config";
import type { EventEnvelope } from "@my-wife/contracts";
import { connectNats, subject } from "@my-wife/service-kit";
import { createApp, SERVICE_NAME } from "./app";
import { createSettingsReader } from "./settings";

const config = loadConfig(process.env);
const identityUrl = process.env.IDENTITY_URL ?? `http://localhost:${servicePort("identity")}`;
const nats = await connectNats(config.natsUrl, SERVICE_NAME);
const app = await createApp(config, {
  nats,
  readSettings: createSettingsReader(identityUrl),
  publish: (event: EventEnvelope) => {
    nats.publish(subject(config.natsSubjectPrefix, event.type), JSON.stringify(event));
  },
});
await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? servicePort(SERVICE_NAME)) });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void app.close().then(() => nats.drain());
  });
}
