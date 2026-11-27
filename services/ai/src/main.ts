import { loadConfig, servicePort } from "@my-wife/config";
import { connectNats, subject } from "@my-wife/service-kit";
import { createApp, SERVICE_NAME } from "./app";
import { createProvider } from "./llm";
import { createEmailFetcher, runTemplateReadConsumer, TemplateReadService } from "./template";

const config = loadConfig(process.env);
const nats = await connectNats(config.natsUrl, SERVICE_NAME);
const publish = async (event: { name: string; payload: unknown }) =>
  nats.publish(subject(config.natsSubjectPrefix, event.name), JSON.stringify(event));
const app = await createApp(config, { nats, publish });

// `template.read_requested` from ingest: the model has no tools and returns fields only.
void runTemplateReadConsumer({
  nats,
  prefix: config.natsSubjectPrefix,
  service: new TemplateReadService({
    provider: createProvider(),
    fetchEmail: createEmailFetcher(
      process.env.INGEST_URL ?? `http://localhost:${servicePort("ingest")}`,
    ),
    publish,
    warn: (fields, message) => app.log.warn(fields, message),
  }),
  log: app.log,
}).catch((error: unknown) =>
  app.log.error(
    { errorName: error instanceof Error ? error.name : "unknown" },
    "template read consumer stopped",
  ),
);

await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? servicePort(SERVICE_NAME)) });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void app.close().then(() => nats.drain());
  });
}
