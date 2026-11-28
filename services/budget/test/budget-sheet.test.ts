import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { CellEditResponseSchema, type EventEnvelope } from "@my-wife/contracts";
import { createApp } from "../src/index";
import { createOnboardingHandler, MemorySampleBudgetStore } from "../src/onboarding";
import { BUDGET_SHEET_TABS } from "../src/budget-sheet";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const NOW = new Date("2026-03-05T10:00:00Z");
const headers = { "x-user-id": "u1" };

async function onboarded() {
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
  const record = (await store.find("u1"))!;
  record.transactions.push({
    id: "t1",
    cycleId: record.cycle.id,
    receiptId: "r1",
    bankTransactionRef: "ref1",
    bankAccountId: record.accounts[0]!.id,
    direction: "out",
    amountVnd: 50_000,
    occurredAt: NOW.toISOString(),
    memo: "lunch",
    counterparty: null,
    transactionType: "coded_unplanned",
    reconciliationResult: "unplanned",
    categoryId: record.categories[0]!.id,
    announced: true,
  });
  record.overspends.push({
    id: "o1",
    cycleId: record.cycle.id,
    weekIndex: 1,
    categoryId: record.categories[0]!.id,
    priority: "need",
    weeklyLimitVnd: 10,
    spentVnd: 20,
    excessVnd: 10,
    announced: true,
  });
  record.penaltyDebts.push({
    cycleId: record.cycle.id,
    categoryId: record.categories[0]!.id,
    amountVnd: 5_000,
  });
  record.plannedItems.push(
    {
      id: "p1",
      categoryId: record.categories[0]!.id,
      number: 1,
      amountVnd: 100_000,
      transferCode: "AN1",
      status: "planned",
    },
    {
      id: "p2",
      categoryId: record.categories[0]!.id,
      number: 2,
      amountVnd: 200_000,
      transferCode: "AN2",
      status: "matched",
    },
  );
  return store;
}

const post = (app: Awaited<ReturnType<typeof createApp>>, body: unknown) =>
  app.inject({ method: "POST", url: "/budget/sheet/cells", headers, payload: body as object });
const edit = (entityId: string, tab: string, field: string, value: unknown) => ({
  sheet: "budget",
  tab,
  cellRef: "A1",
  entityId,
  field,
  value,
});

describe("GET /budget/sheet", () => {
  it("requires the gateway user id", async () => {
    const app = await createApp(config);
    expect((await app.inject({ method: "GET", url: "/budget/sheet" })).statusCode).toBe(401);
  });

  it("returns 404 without a cycle", async () => {
    const app = await createApp(config);
    const res = await app.inject({ method: "GET", url: "/budget/sheet", headers });
    expect(res.statusCode).toBe(404);
  });

  it("returns each of the five tabs with its cells", async () => {
    const store = await onboarded();
    const app = await createApp(config, { store, now: () => NOW });
    const res = await app.inject({ method: "GET", url: "/budget/sheet", headers });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(Object.keys(data.tabs)).toEqual([...BUDGET_SHEET_TABS]);
    for (const tab of BUDGET_SHEET_TABS) {
      expect(data.tabs[tab].length).toBeGreaterThan(0);
      for (const row of data.tabs[tab]) {
        expect(row.cells.length).toBeGreaterThan(0);
      }
    }
    const limit = data.tabs.categories[0].cells.find(
      (c: { field: string }) => c.field === "cycleLimitVnd",
    );
    expect(limit).toMatchObject({ editable: true });
    expect(Number.isInteger(limit.value)).toBe(true);
    const booked = data.tabs.ledger.flatMap((r: { cells: { editable: boolean }[] }) => r.cells);
    expect(booked.every((c: { editable: boolean }) => !c.editable)).toBe(true);
  });

  it("returns one tab when asked", async () => {
    const store = await onboarded();
    const app = await createApp(config, { store, now: () => NOW });
    const res = await app.inject({ method: "GET", url: "/budget/sheet?tab=accounts", headers });
    expect(Object.keys(res.json().data.tabs)).toEqual(["accounts"]);
    const bad = await app.inject({ method: "GET", url: "/budget/sheet?tab=nope", headers });
    expect(bad.statusCode).toBe(400);
  });
});

describe("POST /budget/sheet/cells refuses booked and computed cells", () => {
  const cases = [
    {
      name: "transaction amount",
      id: "t1",
      tab: "ledger",
      field: "amountVnd",
      reason: "booked_fact",
    },
    { name: "transaction memo", id: "t1", tab: "ledger", field: "memo", reason: "booked_fact" },
    {
      name: "fault (overspend)",
      id: "o1",
      tab: "ledger",
      field: "excessVnd",
      reason: "booked_fact",
    },
    {
      name: "penalty debt",
      id: "penalty:CYCLE:CAT",
      tab: "surplus",
      field: "amountVnd",
      reason: "booked_fact",
    },
    {
      name: "matched planned item",
      id: "p2",
      tab: "weeklyPlan",
      field: "amountVnd",
      reason: "booked_fact",
    },
    {
      name: "planned item code",
      id: "p1",
      tab: "weeklyPlan",
      field: "transferCode",
      reason: "locked_cell",
    },
    { name: "account code", id: "ACCOUNT", tab: "accounts", field: "code", reason: "locked_cell" },
    {
      name: "category short code",
      id: "CAT",
      tab: "categories",
      field: "shortCode",
      reason: "locked_cell",
    },
  ];
  it.each(cases)("$name", async (c) => {
    const store = await onboarded();
    const record = (await store.find("u1"))!;
    const id = c.id
      .replace("CYCLE", record.cycle.id)
      .replace("CAT", record.categories[0]!.id)
      .replace("ACCOUNT", record.accounts[0]!.id);
    const app = await createApp(config, { store, now: () => NOW });
    const before = JSON.stringify(record);
    const res = await post(app, edit(id, c.tab, c.field, 1));
    expect(res.statusCode).toBe(200);
    expect(CellEditResponseSchema.parse(res.json())).toEqual({
      ok: true,
      data: { status: "rejected", reason: c.reason },
    });
    expect(JSON.stringify(record)).toBe(before);
  });

  it("refuses a plan edit once the cycle is closed", async () => {
    const store = await onboarded();
    const record = (await store.find("u1"))!;
    record.cycle.state = "closed";
    const app = await createApp(config, { store, now: () => NOW });
    const res = await post(app, edit(record.categories[0]!.id, "categories", "cycleLimitVnd", 1));
    expect(res.json().data).toEqual({ status: "rejected", reason: "past_week" });
  });
});

describe("POST /budget/sheet/cells on plan cells", () => {
  it("changes a category limit and keeps an audit record", async () => {
    const store = await onboarded();
    const record = (await store.find("u1"))!;
    const cat = record.categories[0]!;
    const from = cat.cycleLimitVnd;
    const app = await createApp(config, { store, now: () => NOW });
    const res = await post(app, edit(cat.id, "categories", "cycleLimitVnd", 1_234_000));
    expect(res.json()).toEqual({ ok: true, data: { status: "applied" } });
    expect(cat.cycleLimitVnd).toBe(1_234_000);
    expect(record.audit.at(-1)).toEqual({
      at: NOW.toISOString(),
      userId: "u1",
      action: "plan_cell_edited",
      detail: { field: "cycleLimitVnd", entityId: cat.id, from, to: 1_234_000 },
    });
  });

  it("changes a category name and a planned item amount", async () => {
    const store = await onboarded();
    const record = (await store.find("u1"))!;
    const app = await createApp(config, { store, now: () => NOW });
    const cat = record.categories[0]!;
    await post(app, edit(cat.id, "categories", "name", "Groceries"));
    await post(app, edit("p1", "weeklyPlan", "amountVnd", 150_000));
    expect(cat.name).toBe("Groceries");
    expect(record.plannedItems.find((i) => i.id === "p1")!.amountVnd).toBe(150_000);
    expect(record.audit.filter((a) => a.action === "plan_cell_edited")).toHaveLength(2);
  });

  const invalid = [
    { name: "fraction", value: 10.5 },
    { name: "negative", value: -1 },
    { name: "string", value: "100" },
    { name: "null", value: null },
    { name: "unsafe", value: Number.MAX_SAFE_INTEGER + 1 },
  ];
  it.each(invalid)("rejects a $name limit and changes nothing", async (c) => {
    const store = await onboarded();
    const record = (await store.find("u1"))!;
    const cat = record.categories[0]!;
    const from = cat.cycleLimitVnd;
    const auditLen = record.audit.length;
    const app = await createApp(config, { store, now: () => NOW });
    const res = await post(app, edit(cat.id, "categories", "cycleLimitVnd", c.value));
    expect(res.json().data).toEqual({ status: "rejected", reason: "validation_failed" });
    expect(cat.cycleLimitVnd).toBe(from);
    expect(record.audit).toHaveLength(auditLen);
  });

  it("rejects a blank name", async () => {
    const store = await onboarded();
    const cat = (await store.find("u1"))!.categories[0]!;
    const app = await createApp(config, { store, now: () => NOW });
    const res = await post(app, edit(cat.id, "categories", "name", "  "));
    expect(res.json().data).toEqual({ status: "rejected", reason: "validation_failed" });
  });

  it("answers 404 for an unknown entity and 400 for a malformed or timetable request", async () => {
    const store = await onboarded();
    const app = await createApp(config, { store, now: () => NOW });
    expect((await post(app, edit("nope", "categories", "name", "x"))).statusCode).toBe(404);
    expect((await post(app, { sheet: "budget" })).statusCode).toBe(400);
    const tt = { ...edit("x", "categories", "name", "x"), sheet: "timetable" };
    expect((await post(app, tt)).statusCode).toBe(400);
  });

  it("requires the gateway user id", async () => {
    const app = await createApp(config);
    const res = await app.inject({ method: "POST", url: "/budget/sheet/cells", payload: {} });
    expect(res.statusCode).toBe(401);
  });
});
