import { loadConfig } from "@my-wife/config";
import { createMemoryStore } from "@my-wife/identity";
import { connectNats } from "@my-wife/service-kit";
import { prepareDemoLogin } from "./demo-login";
import { seedE2eSession } from "./e2e-session";
import { startAll } from "./runner";

const config = loadConfig({
  SESSION_SECRET: "dev-only-secret-dev-only-secret-0000",
  ...process.env,
});
const store = createMemoryStore();
// Throws at startup when misconfigured; does nothing unless E2E_SEED_SESSION=1.
await seedE2eSession({ env: process.env, store, secret: config.sessionSecret, now: new Date() });
// Throws at startup in production; does nothing unless DEMO_LOGIN=1 (#292).
const demoLogin = await prepareDemoLogin({
  env: process.env,
  store,
  secret: config.sessionSecret,
  now: new Date(),
});
const nats = process.env.DEV_RUNNER_NO_NATS
  ? undefined
  : await connectNats(config.natsUrl, "dev-runner");
const runner = await startAll(config, { deps: { nats }, identity: { store } });
console.log(
  JSON.stringify({ msg: "dev-runner started", urls: runner.urls, demoLogin: demoLogin?.url }),
);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void Promise.all([runner.stop(), demoLogin?.stop()]).then(() => nats?.drain());
  });
}
