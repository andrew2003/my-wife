import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { createApp, createMemoryStore } from "../src/index";

const SECRET = "sk-ant-SUPERSECRET-0123456789";
const A = { "x-user-id": "ua" };
const B = { "x-user-id": "ub" };
const DEFAULT_KEY = Buffer.alloc(32, 7).toString("base64");

function setup(masterKey: string | null = DEFAULT_KEY) {
  const config = loadConfig({
    SESSION_SECRET: "s".repeat(32),
    LOG_LEVEL: "debug",
    ...(masterKey ? { SECRETS_MASTER_KEY: masterKey } : {}),
  });
  const logs: string[] = [];
  const logStream = new Writable({
    write(chunk, _enc, cb) {
      logs.push(String(chunk));
      cb();
    },
  });
  const store = createMemoryStore();
  const app = createApp(config, { store, logStream, now: () => new Date("2026-01-01T00:00:00Z") });
  return { app, store, logs };
}

const putSecret = (app: ReturnType<typeof setup>["app"], payload: unknown, headers = A) =>
  app.inject({ method: "PUT", url: "/secrets/llm_key", headers, payload: payload as object });

describe("encrypted secrets", () => {
  it("stores ciphertext and never returns or logs the secret", async () => {
    const { app, store, logs } = setup();
    const put = await putSecret(app, { value: SECRET });
    expect(put.statusCode).toBe(200);
    const list = await app.inject({ method: "GET", url: "/secrets", headers: A });
    const del = await app.inject({ method: "DELETE", url: "/secrets/llm_key", headers: B });
    const bad = await putSecret(app, { nope: SECRET });
    for (const res of [put, list, del, bad]) {
      expect(res.body).not.toContain(SECRET);
      expect(JSON.stringify(res.headers)).not.toContain(SECRET);
    }
    expect(JSON.parse(list.body).data).toEqual([
      { kind: "llm_key", keyId: "k1", updatedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const row = await store.findSecret("ua", "llm_key");
    expect(JSON.stringify(row)).not.toContain(SECRET);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join("")).not.toContain(SECRET);
  });

  it("keeps each user's secrets apart", async () => {
    const { app } = setup();
    await putSecret(app, { value: SECRET });
    const list = await app.inject({ method: "GET", url: "/secrets", headers: B });
    expect(JSON.parse(list.body).data).toEqual([]);
  });

  it("deletes a secret", async () => {
    const { app } = setup();
    await putSecret(app, { value: SECRET });
    const del = await app.inject({ method: "DELETE", url: "/secrets/llm_key", headers: A });
    expect(del.statusCode).toBe(200);
    const list = await app.inject({ method: "GET", url: "/secrets", headers: A });
    expect(JSON.parse(list.body).data).toEqual([]);
  });

  it("requires a caller, a known kind and a configured master key", async () => {
    const { app } = setup();
    expect((await app.inject({ method: "GET", url: "/secrets" })).statusCode).toBe(401);
    const kind = await app.inject({
      method: "PUT",
      url: "/secrets/other",
      headers: A,
      payload: { value: "x" },
    });
    expect(kind.statusCode).toBe(400);
    const off = setup(null);
    const res = await putSecret(off.app, { value: SECRET });
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain(SECRET);
  });
});
