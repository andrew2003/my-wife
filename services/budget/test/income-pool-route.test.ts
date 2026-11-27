import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import type { EventEnvelope } from "@my-wife/contracts";
import { createApp } from "../src/index";
import { createOnboardingHandler, MemorySampleBudgetStore } from "../src/onboarding";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const NOW = new Date("2026-03-05T10:00:00Z");
const headers = { "x-user-id": "u1" };

async function running() {
  const store = new MemorySampleBudgetStore();
  let n = 0;
  await createOnboardingHandler({
    store,
    locale: "en",
    now: () => NOW,
    newId: () => `id-${++n}`,
    publish: () => undefined,
  })({
    id: "e0",
    type: "onboarding.step_completed",
    occurredAt: NOW.toISOString(),
    userId: "u1",
    schemaVersion: 1,
    payload: { step: "qa_templates", skipped: true },
  } as EventEnvelope);
  store.get("u1")!.cycle.state = "running";
  return store;
}

describe("income pool and group expense routes", () => {
  it("require the gateway user id", async () => {
    const app = await createApp(config);
    for (const [method, url] of [
      ["POST", "/budget/group-expenses"],
      ["POST", "/budget/income"],
      ["GET", "/budget/income-pool"],
    ] as const) {
      const res = await app.inject({ method, url, payload: {} });
      expect(res.statusCode).toBe(401);
    }
  });

  it("records income and lists the pool", async () => {
    const store = await running();
    const events: EventEnvelope[] = [];
    const app = await createApp(config, { store, publish: (e) => void events.push(e) });
    const res = await app.inject({
      method: "POST",
      url: "/budget/income",
      headers,
      payload: { amountVnd: 12_000_000, payer: "ACME" },
    });
    expect(res.statusCode).toBe(201);
    expect(events.map((e) => e.type)).toEqual(["income.recorded"]);
    const pool = await app.inject({ method: "GET", url: "/budget/income-pool", headers });
    expect(pool.json().data.totalVnd).toBe(12_000_000);
    expect(pool.json().data.entries).toHaveLength(1);
  });

  it("rejects an invalid income body with 400", async () => {
    const store = await running();
    const app = await createApp(config, { store });
    const res = await app.inject({
      method: "POST",
      url: "/budget/income",
      headers,
      payload: { amountVnd: 1.5, payer: "ACME" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("opens receivables for a group expense", async () => {
    const store = await running();
    const app = await createApp(config, { store });
    const res = await app.inject({
      method: "POST",
      url: "/budget/group-expenses",
      headers,
      payload: { totalVnd: 600_000, friends: [{ person: "An" }, { person: "Binh" }] },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.ownShareVnd).toBe(200_000);
    const debts = await app.inject({ method: "GET", url: "/budget/debts", headers });
    expect(debts.json().data.debts).toHaveLength(2);
  });

  it("returns 404 for a user without a cycle and 400 for a bad body", async () => {
    const app = await createApp(config, { store: await running() });
    const missing = await app.inject({
      method: "POST",
      url: "/budget/group-expenses",
      headers: { "x-user-id": "nobody" },
      payload: { totalVnd: 600_000, friends: [{ person: "An" }] },
    });
    expect(missing.statusCode).toBe(404);
    const bad = await app.inject({
      method: "POST",
      url: "/budget/group-expenses",
      headers,
      payload: { totalVnd: 600_000, friends: [] },
    });
    expect(bad.statusCode).toBe(400);
  });
});
