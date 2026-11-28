import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { ListKeysResponseSchema } from "@my-wife/contracts";
import { createApp } from "../src/app";
import { InMemoryLlmKeyStore, type StoredLlmKey } from "../src/keys";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const USER = "demo-user";
const OTHER = "someone-else";
const MATERIAL = "SEALED-CIPHERTEXT-MARKER";

function stored(n: number, userId = USER): StoredLlmKey {
  return {
    keyId: `key_${String(n).padStart(4, "0")}`,
    userId,
    provider: "anthropic",
    model: `m${n}`,
    role: "primary",
    valid: true,
    sealed: { marker: MATERIAL } as never,
  };
}

function seeded(count: number) {
  const store = new InMemoryLlmKeyStore();
  // Inserted out of order on purpose; roles repeat, so rows are seeded directly.
  for (let n = count; n >= 1; n--) store.seed(stored(n));
  store.seed(stored(900, OTHER));
  return store;
}

const setup = (count: number) =>
  createApp(config, { keyStore: seeded(count), readSettings: async () => ({}) });

type App = Awaited<ReturnType<typeof setup>>;
const get = (app: App, url: string, user: string | null = USER) =>
  app.inject({ method: "GET", url, headers: user ? { "x-user-id": user } : {} });

describe("GET /keys", () => {
  it("parses with the shared schema, own keys only, and holds no key material", async () => {
    const res = await get(await setup(3), "/keys");
    expect(res.statusCode).toBe(200);
    const body = ListKeysResponseSchema.parse(res.json());
    if (!body.ok) throw new Error("expected ok");
    expect(body.data.keys).toHaveLength(3);
    expect(res.body).not.toContain(MATERIAL);
    expect(res.body).not.toContain("sealed");
    expect(res.body).not.toContain("key_0900");
    expect(res.json().data.nextCursor).toBeNull();
  });

  it("paginates many keys without gaps or repeats", async () => {
    const app = await setup(45);
    const seen: string[] = [];
    let url = "/keys?limit=20";
    for (let i = 0; i < 5; i++) {
      const body = (await get(app, url)).json();
      expect(body.data.keys.length).toBeLessThanOrEqual(20);
      seen.push(...body.data.keys.map((k: { keyId: string }) => k.keyId));
      if (body.data.nextCursor === null) break;
      url = `/keys?limit=20&cursor=${body.data.nextCursor}`;
    }
    expect(seen).toHaveLength(45);
    expect(new Set(seen).size).toBe(45);
    expect(seen).toEqual([...seen].sort());
  });

  it("caps the page size and rejects bad input", async () => {
    const app = await setup(120);
    expect((await get(app, "/keys?limit=500")).json().data.keys).toHaveLength(100);
    expect((await get(app, "/keys")).json().data.keys).toHaveLength(50);
    expect((await get(app, "/keys?limit=0")).statusCode).toBe(400);
    expect((await get(app, "/keys?cursor=!!")).statusCode).toBe(400);
  });

  it("serves pages from a per-user ordered index", async () => {
    const page = await seeded(30).listPage(USER, 5, null);
    expect(page.items.map((k) => k.keyId)).toEqual([
      "key_0001",
      "key_0002",
      "key_0003",
      "key_0004",
      "key_0005",
    ]);
    expect(page.next).toBe("key_0005");
  });
});
