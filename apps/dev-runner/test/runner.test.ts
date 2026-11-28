import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { SERVICE_NAMES } from "@my-wife/contracts";
import { startAll, type Runner } from "../src/runner";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
let runner: Runner | undefined;

afterEach(async () => {
  await runner?.stop();
  runner = undefined;
});

describe("dev runner", () => {
  it("mounts all ten services in one process", async () => {
    runner = await startAll(config, { ephemeralPorts: true });
    expect(Object.keys(runner.urls).sort()).toEqual([...SERVICE_NAMES].sort());
  });

  it("every mounted service answers /health", async () => {
    runner = await startAll(config, { ephemeralPorts: true });
    for (const name of SERVICE_NAMES) {
      const res = await fetch(`${runner.urls[name]}/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: "ok", service: name });
    }
  });

  it("serves the sync status route with no link yet", async () => {
    runner = await startAll(config, { ephemeralPorts: true });
    const res = await fetch(`${runner.urls.sync}/sync/status`, {
      headers: { "x-user-id": "someone" },
    });
    expect(res.status).toBe(200);
  });
});
