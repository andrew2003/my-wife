import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import type { EventEnvelope } from "@my-wife/contracts";
import { createApp } from "../src/index";
import { createOnboardingHandler, MemorySampleBudgetStore } from "../src/onboarding";
import {
  allocateSavings,
  averageContributionVnd,
  createWishlist,
  estimateCyclesRemaining,
  MemoryWishlistStore,
  readWishlistPool,
  type WishlistEntry,
} from "../src/wishlist";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });

const item = (id: string, priceVnd: number, boughtAt: string | null = null): WishlistEntry => ({
  id,
  name: id,
  priceVnd,
  createdAt: "2026-03-01T00:00:00.000Z",
  boughtAt,
});

describe("allocateSavings (pure)", () => {
  const cases = [
    { name: "no pool", items: [item("a", 100)], pool: 0, saved: [0] },
    { name: "partial", items: [item("a", 100)], pool: 40, saved: [40] },
    { name: "capped at price", items: [item("a", 100)], pool: 250, saved: [100] },
    {
      name: "fills in order",
      items: [item("a", 100), item("b", 100)],
      pool: 150,
      saved: [100, 50],
    },
    {
      name: "bought item consumes its price",
      items: [item("a", 100, "2026-03-02T00:00:00.000Z"), item("b", 100)],
      pool: 150,
      saved: [100, 50],
    },
    {
      name: "bought item beyond the pool never goes negative",
      items: [item("a", 100, "2026-03-02T00:00:00.000Z"), item("b", 100)],
      pool: 60,
      saved: [100, 0],
    },
  ];
  it.each(cases)("$name", ({ items, pool, saved }) => {
    expect(allocateSavings(items, pool).map((i) => i.savedVnd)).toEqual(saved);
  });
  it("reports progress percent rounded down", () => {
    const [r] = allocateSavings([item("a", 300)], 100);
    expect(r!.progressPercent).toBe(33);
    expect(r!.funded).toBe(false);
  });
});

describe("estimateCyclesRemaining (pure)", () => {
  const cases = [
    { price: 1_000_000, saved: 0, contribution: 300_000, expected: 4 },
    { price: 1_000_000, saved: 700_000, contribution: 300_000, expected: 1 },
    { price: 1_000_000, saved: 1_000_000, contribution: 300_000, expected: 0 },
    { price: 1_000_000, saved: 0, contribution: 0, expected: null },
    { price: 1_000_000, saved: 1_000_000, contribution: 0, expected: 0 },
  ];
  it.each(cases)("$price/$saved/$contribution", ({ price, saved, contribution, expected }) => {
    expect(estimateCyclesRemaining(price, saved, contribution)).toBe(expected);
  });
});

describe("averageContributionVnd (pure)", () => {
  it("averages completed cycles, rounding down", () => {
    expect(averageContributionVnd([100, 201], 999)).toBe(150);
  });
  it("uses the planned amount before any cycle", () => {
    expect(averageContributionVnd([], 800_000)).toBe(800_000);
  });
});

describe("wishlist service", () => {
  const NOW = new Date("2026-03-05T10:00:00Z");
  const make = (pool: number, planned = 100_000) => {
    const store = new MemoryWishlistStore();
    let n = 0;
    const wl = createWishlist({
      store,
      now: () => NOW,
      newId: () => `w${++n}`,
      readPool: async () => ({
        savedPoolVnd: pool,
        completedContributionsVnd: [],
        plannedVnd: planned,
      }),
    });
    return { wl, store };
  };

  it("shows progress as savings accumulate", async () => {
    const { wl } = make(250_000);
    await wl.add("u1", { name: "Laptop", priceVnd: 1_000_000 });
    const list = await wl.list("u1");
    expect(list.ok && list.data.items[0]).toMatchObject({
      savedVnd: 250_000,
      progressPercent: 25,
      cyclesRemaining: 8,
      bought: false,
    });
  });

  it("rejects invalid items", async () => {
    const { wl } = make(0);
    for (const bad of [
      { name: "", priceVnd: 10 },
      { name: "x", priceVnd: 0 },
      { name: "x", priceVnd: 1.5 },
    ]) {
      expect(await wl.add("u1", bad)).toMatchObject({
        ok: false,
        error: { code: "budget.invalid_wishlist_item" },
      });
    }
  });

  it("marks a funded item bought and writes audit records", async () => {
    const { wl, store } = make(1_000_000);
    const added = await wl.add("u1", { name: "Laptop", priceVnd: 1_000_000 });
    const id = added.ok ? added.data.id : "";
    const res = await wl.markBought("u1", id);
    expect(res).toMatchObject({ ok: true, data: { bought: true, boughtAt: NOW.toISOString() } });
    expect(store.audit.map((a) => a.action)).toEqual([
      "wishlist_item_added",
      "wishlist_item_bought",
    ]);
  });

  it("refuses an unfunded or unknown item", async () => {
    const { wl } = make(10);
    const added = await wl.add("u1", { name: "Laptop", priceVnd: 1_000_000 });
    const id = added.ok ? added.data.id : "";
    expect(await wl.markBought("u1", id)).toMatchObject({
      ok: false,
      error: { code: "budget.wishlist_not_funded" },
    });
    expect(await wl.markBought("u1", "nope")).toMatchObject({
      ok: false,
      error: { code: "budget.wishlist_item_not_found" },
    });
  });

  it("marking bought twice fails", async () => {
    const { wl } = make(1_000_000);
    const added = await wl.add("u1", { name: "Laptop", priceVnd: 500_000 });
    const id = added.ok ? added.data.id : "";
    await wl.markBought("u1", id);
    expect(await wl.markBought("u1", id)).toMatchObject({
      ok: false,
      error: { code: "budget.wishlist_already_bought" },
    });
  });
});

describe("wishlist routes", () => {
  it("adds, lists and refuses to buy an unfunded item over HTTP", async () => {
    const app = await createApp(config);
    const headers = { "x-user-id": "u1" };
    const created = await app.inject({
      method: "POST",
      url: "/budget/wishlist",
      headers,
      payload: { name: "Bike", priceVnd: 5_000_000 },
    });
    expect(created.statusCode).toBe(201);
    const list = await app.inject({ method: "GET", url: "/budget/wishlist", headers });
    expect(list.json().data.items).toHaveLength(1);
    const id = created.json().data.id;
    const buy = await app.inject({ method: "POST", url: `/budget/wishlist/${id}/bought`, headers });
    expect(buy.statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url: "/budget/wishlist" })).statusCode).toBe(401);
    await app.close();
  });
});

describe("wishlist routes with savings", () => {
  it("marks a funded item bought (200) and answers 404 for an unknown id", async () => {
    const store = new MemorySampleBudgetStore();
    const NOW = new Date("2026-03-05T10:00:00Z");
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
    store.get("u1")!.cycleCloses.push({
      cycleId: "c0",
      allocation: { futurePurchasesVnd: 2_000_000 },
      closedAt: NOW.toISOString(),
      surplusAnnounced: true,
      cycleAnnounced: true,
    } as never);
    const app = await createApp(config, { store, now: () => NOW });
    const headers = { "x-user-id": "u1" };
    const created = await app.inject({
      method: "POST",
      url: "/budget/wishlist",
      headers,
      payload: { name: "Phone", priceVnd: 1_000_000 },
    });
    const id = created.json().data.id;
    const buy = await app.inject({ method: "POST", url: `/budget/wishlist/${id}/bought`, headers });
    expect(buy.statusCode).toBe(200);
    expect(buy.json().data).toMatchObject({ bought: true, boughtAt: NOW.toISOString() });
    const missing = await app.inject({
      method: "POST",
      url: "/budget/wishlist/nope/bought",
      headers,
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});

describe("readWishlistPool (pure)", () => {
  it("adds the category limit and the surplus share of every closed cycle", () => {
    const pool = readWishlistPool({
      categories: [
        { key: "food", cycleLimitVnd: 9 },
        { key: "future_purchases", cycleLimitVnd: 800_000 },
      ],
      cycleCloses: [
        { allocation: { futurePurchasesVnd: 100_000 } },
        { allocation: { futurePurchasesVnd: 0 } },
      ],
    });
    expect(pool).toEqual({
      savedPoolVnd: 1_700_000,
      completedContributionsVnd: [900_000, 800_000],
      plannedVnd: 800_000,
    });
  });
  it("finds the category by key even when the user renamed its short code", () => {
    const pool = readWishlistPool({
      categories: [{ key: "future_purchases", cycleLimitVnd: 500_000, shortCode: "ZZ" } as never],
      cycleCloses: [{ allocation: { futurePurchasesVnd: 0 } }],
    });
    expect(pool.plannedVnd).toBe(500_000);
  });
  it("counts only surplus shares when the category is missing", () => {
    const pool = readWishlistPool({
      categories: [{ cycleLimitVnd: 700_000 }],
      cycleCloses: [{ allocation: { futurePurchasesVnd: 100_000 } }],
    });
    expect(pool).toEqual({
      savedPoolVnd: 100_000,
      completedContributionsVnd: [100_000],
      plannedVnd: 0,
    });
  });
  it("is empty without a record", () => {
    expect(readWishlistPool(undefined)).toEqual({
      savedPoolVnd: 0,
      completedContributionsVnd: [],
      plannedVnd: 0,
    });
  });
});
