import { loadConfig, servicePort } from "@my-wife/config";
import { connectNats } from "@my-wife/service-kit";
import { createApp, SERVICE_NAME } from "./app";

const config = loadConfig(process.env);
const nats = await connectNats(config.natsUrl, SERVICE_NAME);
const app = await createApp(config, { nats, bootstrapAdminEmail: process.env.ADMIN_EMAIL });
await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? servicePort(SERVICE_NAME)) });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void app.close().then(() => nats.drain());
  });
}
