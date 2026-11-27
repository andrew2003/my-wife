import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@my-wife/config";
import { createApp as createGateway } from "@my-wife/gateway";
import { createMemoryStore } from "@my-wife/identity";
import { startAll, type Runner } from "../src/runner";
import { DEMO_USER_EMAIL } from "../src/demo-state";
import { prepareDemoLogin, type DemoLogin } from "../src/demo-login";

const SECRET = "s".repeat(40);
const now = new Date("2026-11-27T03:00:00Z");
let runner: Runner | undefined;
let login: DemoLogin | undefined;

afterEach(async () => {
  await login?.stop();
  login = undefined;
  await runner?.stop();
  runner = undefined;
  vi.restoreAllMocks();
});

describe("prepareDemoLogin", () => {
  it.each([
    ["flag unset", {}, false],
    ["flag 0", { DEMO_LOGIN: "0" }, false],
    ["flag set, test env", { DEMO_LOGIN: "1", NODE_ENV: "test" }, true],
    ["flag set, no env", { DEMO_LOGIN: "1" }, true],
  ])("%s", async (_name, env, enabled) => {
    const store = createMemoryStore();
    const result = await prepareDemoLogin({ env, store, secret: SECRET, now, port: 0 });
    login = result;
    expect(result !== undefined).toBe(enabled);
    expect(await store.countUsers()).toBe(enabled ? 1 : 0);
  });

  it("throws at startup in production and seeds nothing", async () => {
    const store = createMemoryStore();
    await expect(
      prepareDemoLogin({
        env: { DEMO_LOGIN: "1", NODE_ENV: "production" },
        store,
        secret: SECRET,
        now,
        port: 0,
      }),
    ).rejects.toThrow(/production/);
    expect(await store.countUsers()).toBe(0);
  });

  it("sets a session cookie the gateway accepts and redirects to the web app", async () => {
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "info"), vi.spyOn(console, "warn")];
    const store = createMemoryStore();
    const config = loadConfig({ SESSION_SECRET: SECRET, LOG_LEVEL: "silent" });
    login = await prepareDemoLogin({
      env: { DEMO_LOGIN: "1", WEB_URL: "http://localhost:3000" },
      store,
      secret: SECRET,
      now,
      port: 0,
    });
    const res = await fetch(`${login!.url}/demo-login`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://localhost:3000/");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^mw_session=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\//);
    const value = setCookie.split(";")[0]!.split("=").slice(1).join("=");
    for (const spy of logs) expect(JSON.stringify(spy.mock.calls)).not.toContain(value);

    runner = await startAll(config, { ephemeralPorts: true, identity: { store } });
    const { identity, budget, schedule, rules } = runner.urls;
    const gateway = await createGateway(
      config,
      {},
      { upstreams: { identity, budget, schedule, rules } },
    );
    const me = await gateway.inject({
      method: "GET",
      url: "/api/me",
      headers: { cookie: `mw_session=${value}` },
    });
    await gateway.close();
    expect(me.statusCode).toBe(200);
    expect(me.json().data.user.email).toBe(DEMO_USER_EMAIL);
  });

  it("answers other paths with 404 and shows no secret", async () => {
    login = await prepareDemoLogin({
      env: { DEMO_LOGIN: "1" },
      store: createMemoryStore(),
      secret: SECRET,
      now,
      port: 0,
    });
    const res = await fetch(`${login!.url}/other`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(SECRET);
  });
});
