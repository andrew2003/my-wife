import { Writable } from "node:stream";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { createApp } from "../src/index";
import { InMemoryLlmKeyStore, type KeyValidator } from "../src/keys";

const MASTER = randomBytes(32).toString("base64");
const SECRET = "sk-test-SUPER-secret-1234567890";
const BAD_SECRET = "sk-bad-NOPE-0987654321";

const config = (master?: string) =>
  loadConfig({
    SESSION_SECRET: "x".repeat(32),
    LOG_LEVEL: "debug",
    UI_LANGUAGE: "en",
    ...(master ? { SECRETS_MASTER_KEY: master } : {}),
  });

const validator: KeyValidator = {
  validate: async ({ apiKey }) => !apiKey.startsWith("sk-bad"),
};

type App = Awaited<ReturnType<typeof createApp>>;

async function setup(master: string | undefined = MASTER, keyValidator: KeyValidator = validator) {
  const events: { name: string; payload: unknown }[] = [];
  const logs: string[] = [];
  const keyStore = new InMemoryLlmKeyStore();
  const logStream = new Writable({
    write(chunk, _enc, cb) {
      logs.push(String(chunk));
      cb();
    },
  });
  const app = await createApp(config(master), {
    keyStore,
    keyValidator,
    logStream,
    readSettings: async () => ({}),
    publish: async (e) => {
      events.push(e);
    },
  });
  return { app, events, logs, keyStore };
}
const save = (app: App, apiKey: string, extra: Record<string, unknown> = {}) =>
  app.inject({
    method: "POST",
    url: "/keys",
    headers: { "x-user-id": "u1" },
    payload: { provider: "anthropic", model: "m1", role: "primary", apiKey, ...extra },
  });
const list = (app: App) =>
  app.inject({ method: "GET", url: "/keys", headers: { "x-user-id": "u1" } });

describe("bring-your-own llm keys", () => {
  it("never exposes a saved key in responses, logs, events or the store", async () => {
    const { app, events, logs, keyStore } = await setup();
    const saved = await save(app, SECRET);
    expect(saved.statusCode).toBe(200);
    const listed = await list(app);
    const rejected = await save(app, SECRET, { provider: "nope" });
    expect(rejected.statusCode).toBe(400);
    const all = [saved.body, listed.body, rejected.body, JSON.stringify(events), logs.join("")];
    for (const text of all) expect(text).not.toContain(SECRET);
    expect(JSON.stringify(keyStore.dump())).not.toContain(SECRET);
    expect(listed.json().data.keys).toEqual([
      {
        provider: "anthropic",
        model: "m1",
        keyId: expect.any(String),
        valid: true,
        role: "primary",
      },
    ]);
    expect(events.map((e) => e.name)).toEqual(["llm_key.saved"]);
  });

  it("emits llm_key.invalid for an invalid key and stores it as invalid", async () => {
    const { app, events, logs } = await setup();
    const res = await save(app, BAD_SECRET);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.key.valid).toBe(false);
    expect(events).toEqual([
      { name: "llm_key.invalid", payload: { role: "primary", keyId: res.json().data.key.keyId } },
    ]);
    expect(res.body + logs.join("")).not.toContain(BAD_SECRET);
  });

  it("treats a validator failure as an invalid key without leaking it", async () => {
    const { app, events, logs } = await setup(MASTER, {
      validate: async () => {
        throw new Error(`boom ${SECRET}`);
      },
    });
    const res = await save(app, SECRET);
    expect(res.json().data.key.valid).toBe(false);
    expect(events[0]?.name).toBe("llm_key.invalid");
    expect(res.body + logs.join("")).not.toContain(SECRET);
  });

  it("encrypts at rest and decrypts only through the internal resolver", async () => {
    const { app, keyStore } = await setup();
    await save(app, SECRET);
    const [row] = keyStore.dump();
    expect(row?.sealed.keyId).toBe("k1");
    expect(await app.llmKeys.resolve("u1", "primary")).toMatchObject({
      apiKey: SECRET,
      provider: "anthropic",
    });
    expect(await app.llmKeys.resolve("u2", "primary")).toBeNull();
  });

  it("replaces the key of the same role and deletes by id", async () => {
    const { app } = await setup();
    await save(app, SECRET);
    const second = await save(app, "sk-other-1234567890");
    expect((await list(app)).json().data.keys).toHaveLength(1);
    const del = await app.inject({
      method: "DELETE",
      url: `/keys/${second.json().data.key.keyId}`,
      headers: { "x-user-id": "u1" },
    });
    expect(del.statusCode).toBe(200);
    expect((await list(app)).json().data.keys).toHaveLength(0);
  });

  it("rejects bad requests and is unavailable without a master key", async () => {
    const { app } = await setup();
    expect((await save(app, "")).statusCode).toBe(400);
    const off = await setup("");
    const res = await save(off.app, SECRET);
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain(SECRET);
  });
});
