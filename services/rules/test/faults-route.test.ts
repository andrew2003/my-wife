import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { ListFaultsResponseSchema } from "@my-wife/contracts";
import { createApp } from "../src/app";
import { InMemoryFaultStore, type FaultLedgerEntry } from "../src/fault";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";

function fault(n: number, occurredAt: string): FaultLedgerEntry {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    type: "camera_off",
    occurredAt,
    signalRef: `sig-${n}`,
    reasonRef: null,
    weightSnapshot: 2,
    points: 2,
    status: "recorded",
    waiver: null,
    systemCause: null,
    honestReason: false,
  } as FaultLedgerEntry;
}

function setup(count: number) {
  const store = new InMemoryFaultStore();
  for (let n = 1; n <= count; n++) {
    // Inserted out of order on purpose: the page order must not depend on it.
    const day = String(((n * 7) % 28) + 1).padStart(2, "0");
    store.insertOnce(USER, fault(n, `2026-11-${day}T0${n % 10}:00:00.000Z`), {
      id: `a${n}`,
    } as never);
  }
  store.insertOnce(OTHER, fault(900, "2026-11-30T00:00:00.000Z"), { id: "a900" } as never);
  return createApp(config, { faultStore: store });
}

const get = (app: ReturnType<typeof setup>, url: string, user: string | null = USER) =>
  app.inject({ method: "GET", url, headers: user ? { "x-user-id": user } : {} });

describe("GET /faults", () => {
  it("requires the forwarded user id", async () => {
    expect((await get(setup(1), "/faults", null)).statusCode).toBe(401);
  });

  it("returns a body that parses with the shared schema, own faults only", async () => {
    const res = await get(setup(3), "/faults");
    expect(res.statusCode).toBe(200);
    const body = ListFaultsResponseSchema.parse(res.json());
    expect(body.ok && body.data.faults).toHaveLength(3);
    expect(JSON.stringify(res.json())).not.toContain("honestReason");
    expect(JSON.stringify(res.json())).not.toContain("sig-900");
  });

  it("returns an empty list for a user without faults", async () => {
    const res = await get(setup(1), "/faults", "55555555-5555-4555-8555-555555555555");
    const body = ListFaultsResponseSchema.parse(res.json());
    expect(body.ok && body.data.faults).toEqual([]);
    expect(res.json().data.nextCursor).toBeNull();
  });

  it("paginates newest first without gaps or duplicates", async () => {
    const app = setup(25);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await get(app, `/faults?limit=10${cursor ? `&cursor=${cursor}` : ""}`);
      const json = res.json();
      expect(json.data.faults.length).toBeLessThanOrEqual(10);
      for (const f of json.data.faults) seen.push(f.occurredAt + "|" + f.id);
      cursor = json.data.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(25);
    expect(seen).toEqual([...seen].sort().reverse());
  });

  it("applies a default and a maximum page size", async () => {
    const app = setup(130);
    expect((await get(app, "/faults")).json().data.faults).toHaveLength(50);
    expect((await get(app, "/faults?limit=1000")).json().data.faults).toHaveLength(100);
  });

  it("rejects a bad limit or cursor", async () => {
    const app = setup(2);
    expect((await get(app, "/faults?limit=0")).statusCode).toBe(400);
    expect((await get(app, "/faults?limit=abc")).statusCode).toBe(400);
    expect((await get(app, "/faults?cursor=garbage")).statusCode).toBe(400);
  });
});

describe("InMemoryFaultStore.listPage", () => {
  it("serves pages from an index ordered by occurredAt then id, kept on insert", () => {
    const store = new InMemoryFaultStore();
    store.insertOnce(USER, fault(1, "2026-11-02T00:00:00.000Z"), { id: "a" } as never);
    store.insertOnce(USER, fault(2, "2026-11-05T00:00:00.000Z"), { id: "b" } as never);
    store.insertOnce(USER, fault(3, "2026-11-02T00:00:00.000Z"), { id: "c" } as never);
    const page = store.listPage(USER, 2, null);
    expect(page.items.map((f) => f.signalRef)).toEqual(["sig-2", "sig-3"]);
    expect(page.next).not.toBeNull();
    const rest = store.listPage(USER, 2, page.next);
    expect(rest.items.map((f) => f.signalRef)).toEqual(["sig-1"]);
    expect(rest.next).toBeNull();
  });
});
