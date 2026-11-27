import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { createApp as createGateway } from "@my-wife/gateway";
import { createMemoryStore } from "@my-wife/identity";
import { seedE2eSession } from "../src/e2e-session";
import { startAll, type Runner } from "../src/runner";

const SECRET = "s".repeat(40);
let dir: string;
let runner: Runner | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "onboarding-events-"));
});
afterEach(async () => {
  await runner?.stop();
  runner = undefined;
  await rm(dir, { recursive: true, force: true });
});

describe("onboarding.step_completed in the dev runner", () => {
  it("generates the sample schedule and the sample budget cycle", async () => {
    const file = join(dir, "cookie.txt");
    const store = createMemoryStore();
    const config = loadConfig({ SESSION_SECRET: SECRET, LOG_LEVEL: "silent" });
    await seedE2eSession({
      env: { E2E_SEED_SESSION: "1", NODE_ENV: "test", E2E_SESSION_COOKIE_FILE: file },
      store,
      secret: config.sessionSecret,
      now: new Date(),
    });
    const cookie = `mw_session=${(await readFile(file, "utf8")).trim()}`;
    runner = await startAll(config, { ephemeralPorts: true, identity: { store } });
    const { identity, budget, schedule, rules } = runner.urls;
    const gateway = await createGateway(
      config,
      {},
      { upstreams: { identity, budget, schedule, rules } },
    );
    const get = (url: string) => gateway.inject({ method: "GET", url, headers: { cookie } });
    try {
      expect((await get("/api/sample-schedule")).statusCode).toBe(404);
      const step = await gateway.inject({
        method: "POST",
        url: "/api/onboarding/steps",
        headers: { cookie },
        payload: { step: "qa_templates", skipped: true },
      });
      expect(step.statusCode).toBe(200);
      for (const url of ["/api/sample-schedule", "/api/budget/sample-cycle"]) {
        expect((await get(url)).statusCode).toBe(200);
      }
    } finally {
      await gateway.close();
    }
  });

  it("shifts the sample schedule to the wake time answered in onboarding", async () => {
    const file = join(dir, "cookie.txt");
    const store = createMemoryStore();
    const config = loadConfig({ SESSION_SECRET: SECRET, LOG_LEVEL: "silent" });
    await seedE2eSession({
      env: { E2E_SEED_SESSION: "1", NODE_ENV: "test", E2E_SESSION_COOKIE_FILE: file },
      store,
      secret: config.sessionSecret,
      now: new Date(),
    });
    const cookie = `mw_session=${(await readFile(file, "utf8")).trim()}`;
    runner = await startAll(config, { ephemeralPorts: true, identity: { store } });
    const { identity, budget, schedule, rules } = runner.urls;
    const gateway = await createGateway(
      config,
      {},
      { upstreams: { identity, budget, schedule, rules } },
    );
    try {
      for (const [key, value] of [
        ["routine.wake.time", "06:30"],
        ["routine.sleep.start", "22:30"],
      ]) {
        const put = await gateway.inject({
          method: "PUT",
          url: "/api/settings",
          headers: { cookie },
          payload: { key, value },
        });
        expect(put.statusCode).toBe(200);
      }
      await gateway.inject({
        method: "POST",
        url: "/api/onboarding/steps",
        headers: { cookie },
        payload: { step: "qa_templates", skipped: false },
      });
      const res = await gateway.inject({
        method: "GET",
        url: "/api/sample-schedule",
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("06:30");
      expect(res.body).toContain("22:30");
    } finally {
      await gateway.close();
    }
  });
});
