import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import type { EventEnvelope } from "@my-wife/contracts";
import { createApp } from "../src/index";
import { createOnboardingHandler, MemorySampleBudgetStore } from "../src/onboarding";
import { createPlanPublisher } from "../src/plan-publish";
import { createTransactionHandler } from "../src/transactions";

const NOW = new Date("2026-03-05T10:00:00Z");

function receipt(ref: string, amount: number, memo: string, hint: string): EventEnvelope {
  return {
    id: `ev-${ref}`,
    type: "receipt.parsed",
    occurredAt: NOW.toISOString(),
    userId: "u1",
    schemaVersion: 1,
    payload: {
      receiptId: `r-${ref}`,
      bankTransactionRef: ref,
      bankAccountHint: hint,
      direction: "out",
      amountVnd: amount,
      currency: "VND",
      counterparty: null,
      memo,
      occurredAt: NOW.toISOString(),
      source: "email",
      fxProvisional: false,
    },
  } as unknown as EventEnvelope;
}

async function setup() {
  const store = new MemorySampleBudgetStore();
  let n = 0;
  const newId = () => `id-${++n}`;
  await createOnboardingHandler({
    store,
    locale: "en",
    now: () => NOW,
    newId,
    publish: () => undefined,
  })({
    id: "e0",
    type: "onboarding.step_completed",
    occurredAt: NOW.toISOString(),
    userId: "u1",
    schemaVersion: 1,
    payload: { step: "qa_templates", skipped: true },
  } as EventEnvelope);
  const record = store.get("u1")!;
  record.cycle.state = "running";
  const category = record.categories.find((c) => c.shortCode === "AN")!;
  const account = record.accounts.find((a) => a.id === category.bankAccountId)!;
  const published: EventEnvelope[] = [];
  const publish = (e: EventEnvelope) => void published.push(e);
  return {
    store,
    category,
    account,
    published,
    publishPlan: createPlanPublisher({ store, now: () => NOW, publish }),
    handle: createTransactionHandler({
      store,
      now: () => NOW,
      newId,
      publish,
      readSettings: async () => ({}),
    }),
  };
}

describe("publishing planned items (#307)", () => {
  it("stores items with issued codes and announces the week", async () => {
    const s = await setup();
    const result = await s.publishPlan({
      userId: "u1",
      weekIndex: 1,
      items: [
        { categoryId: s.category.id, amountVnd: 1_000_000 },
        { categoryId: s.category.id, amountVnd: 200_000 },
      ],
    });
    expect(result.ok).toBe(true);
    const items = s.store.get("u1")!.plannedItems;
    expect(items.map((i) => i.transferCode)).toEqual(["MW-C01W1-AN-01", "MW-C01W1-AN-02"]);
    expect(items.map((i) => i.number)).toEqual([1, 2]);
    expect(items.every((i) => i.status === "planned")).toBe(true);
    expect(s.store.get("u1")!.audit.some((a) => a.action === "weekly_plan_published")).toBe(true);
    expect(s.published.map((e) => e.type)).toEqual(["plan.week_published"]);
  });

  it("rejects an unknown category, a bad amount and a repeated week", async () => {
    const s = await setup();
    const bad = await s.publishPlan({
      userId: "u1",
      weekIndex: 1,
      items: [{ categoryId: "nope", amountVnd: 1000 }],
    });
    expect(bad).toMatchObject({ ok: false, error: { code: "budget.category_not_found" } });
    const frac = await s.publishPlan({
      userId: "u1",
      weekIndex: 1,
      items: [{ categoryId: s.category.id, amountVnd: 10.5 }],
    });
    expect(frac).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    await s.publishPlan({
      userId: "u1",
      weekIndex: 1,
      items: [{ categoryId: s.category.id, amountVnd: 1000 }],
    });
    const again = await s.publishPlan({
      userId: "u1",
      weekIndex: 1,
      items: [{ categoryId: s.category.id, amountVnd: 2000 }],
    });
    expect(again).toMatchObject({ ok: false, error: { code: "budget.week_already_published" } });
    expect(s.store.get("u1")!.plannedItems).toHaveLength(1);
  });

  it("requires a running cycle", async () => {
    const s = await setup();
    s.store.get("u1")!.cycle.state = "draft";
    const r = await s.publishPlan({
      userId: "u1",
      weekIndex: 1,
      items: [{ categoryId: s.category.id, amountVnd: 1000 }],
    });
    expect(r).toMatchObject({ ok: false, error: { code: "budget.cycle_not_running" } });
  });

  it("reconciles against a published item; a later receipt is its own transaction", async () => {
    const s = await setup();
    await s.publishPlan({
      userId: "u1",
      weekIndex: 1,
      items: [{ categoryId: s.category.id, amountVnd: 1_000_000 }],
    });
    await s.handle(receipt("a", 1_200_000, "MW-C01W1-AN-01", s.account.code));
    const first = { ...s.store.get("u1")!.transactions[0]! };
    expect(first.reconciliationResult).toBe("amount_mismatch");
    expect(s.store.get("u1")!.plannedItems[0]!.status).toBe("mismatch");

    await s.handle(receipt("b", 1_000_000, "MW-C01W1-AN-01", s.account.code));
    const txns = s.store.get("u1")!.transactions;
    expect(txns).toHaveLength(2);
    expect(txns[0]).toEqual(first);
    expect(txns[1]).toMatchObject({
      reconciliationResult: "matched",
      plannedItemId: first.plannedItemId,
    });
    expect(s.store.get("u1")!.plannedItems[0]!.status).toBe("matched");
  });
});

describe("POST /budget/weekly-plan", () => {
  const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });

  it("requires the user header and a valid body", async () => {
    const app = await createApp(config);
    const res = await app.inject({ method: "POST", url: "/budget/weekly-plan", payload: {} });
    expect(res.statusCode).toBe(401);
    const res2 = await app.inject({
      method: "POST",
      url: "/budget/weekly-plan",
      headers: { "x-user-id": "u1" },
      payload: { weekIndex: 0 },
    });
    expect(res2.statusCode).toBe(400);
  });

  it("publishes items into the record", async () => {
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
    const category = store.get("u1")!.categories.find((c) => c.shortCode === "AN")!;
    const app = await createApp(config, { store, now: () => NOW });
    const res = await app.inject({
      method: "POST",
      url: "/budget/weekly-plan",
      headers: { "x-user-id": "u1" },
      payload: { weekIndex: 1, items: [{ categoryId: category.id, amountVnd: 50_000 }] },
    });
    expect(res.statusCode).toBe(200);
    expect(store.get("u1")!.plannedItems).toHaveLength(1);
  });
});
