import { loadConfig } from "@my-wife/config";
import { connectNats } from "@my-wife/service-kit";
import { startAll } from "./runner";

const config = loadConfig({
  SESSION_SECRET: "dev-only-secret-dev-only-secret-0000",
  ...process.env,
});
const nats = process.env.DEV_RUNNER_NO_NATS
  ? undefined
  : await connectNats(config.natsUrl, "dev-runner");
const runner = await startAll(config, { deps: { nats } });
console.log(JSON.stringify({ msg: "dev-runner started", urls: runner.urls }));

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void runner.stop().then(() => nats?.drain());
  });
}
