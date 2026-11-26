import { loadConfig, servicePort } from "@my-wife/config";
import { connectNats, createDb, subject } from "@my-wife/service-kit";
import { createApp, SERVICE_NAME } from "./app";
import { createDrizzleStore } from "./drizzle-store";

const config = loadConfig(process.env);
const nats = await connectNats(config.natsUrl, SERVICE_NAME);
const { db, close } = createDb(config.databaseUrl);
const app = await createApp(config, {
  nats,
  store: createDrizzleStore(db),
  publish: (event) =>
    nats.publish(subject(config.natsSubjectPrefix, event.type), JSON.stringify(event)),
  bootstrapAdminEmail: process.env.ADMIN_EMAIL,
});
await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? servicePort(SERVICE_NAME)) });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void app
      .close()
      .then(() => nats.drain())
      .then(close);
  });
}
