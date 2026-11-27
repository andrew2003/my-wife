import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import type { EventEnvelope } from "@my-wife/contracts";
import { createApp, createMemoryStore } from "../src/index";

const SECRET = "sk-ant-SUPERSECRET-0123456789";
const A = { "x-user-id": "ua" };
const B = { "x-user-id": "ub" };
const KEY = Buffer.alloc(32, 7).toString("base64");

async function setup(settings: Record<string, number> = {}) {
  let clock = new Date("2026-01-01T00:00:00Z");
  const events: EventEnvelope[] = [];
  const store = createMemoryStore();
  for (const id of ["ua", "ub"])
    await store.insertUser({
      id,
      email: `${id}@example.com`,
      state: "active",
      role: "user",
      locale: "vi",
      lastSeenAt: null,
      activatedEventAt: null,
    });
  const config = loadConfig({ SESSION_SECRET: "s".repeat(32), SECRETS_MASTER_KEY: KEY });
  const app = createApp(config, {
    store,
    settings,
    now: () => clock,
    publish: (e) => void events.push(e),
  });
  await app.inject({ method: "PUT", url: "/secrets/llm_key", headers: A, payload: { value: SECRET } });
  await app.inject({ method: "PUT", url: "/settings", headers: A, payload: { key: "budget.cycle_weeks", value: 3 } });
  await app.inject({ method: "POST", url: "/consents", headers: A, payload: { kind: "email", textVersion: 1 } });
  events.length = 0;
  return { app, events, store, tick: (d: Date) => (clock = d) };
}
const request = (app: Awaited<ReturnType<typeof setup>>["app"], headers = A) =>
  app.inject({ method: "POST", url: "/export", headers });

describe("personal data export", () => {
  it("requires a signed-in caller", async () => {
    const { app } = await setup();
    expect((await app.inject({ method: "POST", url: "/export" })).statusCode).toBe(401);
  });

  it("emits export.ready and returns a download that holds the user's data but no secrets", async () => {
    const { app, events, store } = await setup();
    const res = await request(app);
    expect(res.statusCode).toBe(200);
    const { downloadUrl, expiresAt } = res.json().data;
    expect(expiresAt).toBe("2026-01-02T00:00:00.000Z");
    expect(events.map((e) => [e.type, e.userId])).toEqual([["export.ready", "ua"]]);
    expect(events[0]?.payload).toEqual({ expiresAt });
    expect(JSON.stringify(events[0])).not.toContain(downloadUrl);

    const dl = await app.inject({ method: "GET", url: new URL(downloadUrl).pathname, headers: A });
    expect(dl.statusCode).toBe(200);
    const body = dl.body;
    const data = dl.json();
    expect(data.profile.email).toBe("ua@example.com");
    expect(data.settings["budget.cycle_weeks"]).toBe(3);
    expect(data.consents).toHaveLength(1);
    // Secrets, ciphertext, hashes and tokens never appear.
    const sealed = await store.findSecret("ua", "llm_key");
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain(sealed!.payload);
    expect(body).not.toMatch(/tokenHash|token_hash|payload|secret|password|llm_key/i);
    expect(body).not.toContain("ub@example.com");
  });

  it("never lists session or token records", async () => {
    const { app, store } = await setup();
    await store.saveSession({
      id: "sess-1",
      userId: "ua",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-02-01T00:00:00.000Z",
      revokedAt: null,
    });
    const { downloadUrl } = (await request(app)).json().data;
    const dl = await app.inject({ method: "GET", url: new URL(downloadUrl).pathname, headers: A });
    expect(dl.body).not.toContain("sess-1");
  });

  it("link lifetime follows identity.export_ttl_hours", async () => {
    const { app, tick } = await setup({ "identity.export_ttl_hours": 2 });
    const { downloadUrl, expiresAt } = (await request(app)).json().data;
    expect(expiresAt).toBe("2026-01-01T02:00:00.000Z");
    tick(new Date("2026-01-01T02:00:00Z"));
    const dl = await app.inject({ method: "GET", url: new URL(downloadUrl).pathname, headers: A });
    expect(dl.statusCode).toBe(410);
  });

  it("only the owner can download", async () => {
    const { app } = await setup();
    const { downloadUrl } = (await request(app)).json().data;
    const path = new URL(downloadUrl).pathname;
    expect((await app.inject({ method: "GET", url: path, headers: B })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: path })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/exports/nope", headers: A })).statusCode).toBe(404);
  });
});
