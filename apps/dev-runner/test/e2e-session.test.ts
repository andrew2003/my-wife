import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@my-wife/config";
import { createApp as createGateway } from "@my-wife/gateway";
import { createMemoryStore } from "@my-wife/identity";
import { startAll, type Runner } from "../src/runner";
import { E2E_USER_EMAIL, seedE2eSession } from "../src/e2e-session";

const SECRET = "s".repeat(40);
let dir: string;
let file: string;
let runner: Runner | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "e2e-session-"));
  file = join(dir, "cookie.txt");
});
afterEach(async () => {
  await runner?.stop();
  runner = undefined;
  await rm(dir, { recursive: true, force: true });
});

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

describe("seedE2eSession", () => {
  it("throws in production and writes no file", async () => {
    const store = createMemoryStore();
    await expect(
      seedE2eSession({
        env: { E2E_SEED_SESSION: "1", NODE_ENV: "production", E2E_SESSION_COOKIE_FILE: file },
        store,
        secret: SECRET,
        now: new Date(),
      }),
    ).rejects.toThrow(/production/);
    expect(await exists(file)).toBe(false);
    expect(await store.countUsers()).toBe(0);
  });

  it("throws when the file path is missing", async () => {
    await expect(
      seedE2eSession({
        env: { E2E_SEED_SESSION: "1" },
        store: createMemoryStore(),
        secret: SECRET,
        now: new Date(),
      }),
    ).rejects.toThrow(/E2E_SESSION_COOKIE_FILE/);
  });

  it("seeds nothing when the flag is unset", async () => {
    const store = createMemoryStore();
    const done = await seedE2eSession({
      env: { E2E_SESSION_COOKIE_FILE: file },
      store,
      secret: SECRET,
      now: new Date(),
    });
    expect(done).toBe(false);
    expect(await exists(file)).toBe(false);
    expect(await store.countUsers()).toBe(0);
  });

  it("writes a 0600 cookie file the gateway accepts, without logging it", async () => {
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "info"), vi.spyOn(console, "warn")];
    const store = createMemoryStore();
    const config = loadConfig({ SESSION_SECRET: SECRET, LOG_LEVEL: "silent" });
    const done = await seedE2eSession({
      env: { E2E_SEED_SESSION: "1", NODE_ENV: "test", E2E_SESSION_COOKIE_FILE: file },
      store,
      secret: config.sessionSecret,
      now: new Date(),
    });
    expect(done).toBe(true);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const value = (await readFile(file, "utf8")).trim();
    for (const spy of logs) expect(JSON.stringify(spy.mock.calls)).not.toContain(value);

    runner = await startAll(config, { ephemeralPorts: true, identity: { store } });
    // The runner's gateway uses fixed ports; a gateway pointed at the ephemeral identity
    // service verifies the same cookie the same way.
    const { identity, budget, schedule } = runner.urls;
    const gateway = await createGateway(config, {}, { upstreams: { identity, budget, schedule } });
    const res = await gateway.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: `mw_session=${value}` },
    });
    await gateway.close();
    expect(res.statusCode).toBe(200);
    expect(res.json().data.user.email).toBe(E2E_USER_EMAIL);
    vi.restoreAllMocks();
  });
});
