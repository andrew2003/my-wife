import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import type { EventEnvelope } from "@my-wife/contracts";
import { createApp } from "../src/index";
import { createOnboardingHandler, MemorySampleBudgetStore } from "../src/onboarding";
import {
  DEFAULT_MEALS_PER_DAY,
  DEFAULT_MENU_DAYS,
  generateWeeklyMenu,
  parseMenuRequest,
  type MenuDish,
} from "../src/weekly-menu";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });

const rice: MenuDish = {
  name: "Rice and egg",
  ingredients: [
    { name: "Rice", unit: "g", quantity: 200, unitPriceVnd: 20 },
    { name: "Egg", unit: "pc", quantity: 2, unitPriceVnd: 3_000 },
  ],
}; // 4,000 + 6,000 = 10,000
const soup: MenuDish = {
  name: "Soup",
  ingredients: [
    { name: "rice ", unit: "g", quantity: 100, unitPriceVnd: 20 },
    { name: "Pork", unit: "g", quantity: 150, unitPriceVnd: 200 },
  ],
}; // 2,000 + 30,000 = 32,000

const base = { days: 4, mealsPerDay: 1, estimateEnabled: true };

describe("generateWeeklyMenu (pure)", () => {
  const cases = [
    {
      name: "spreads dishes over the days in order and fits",
      input: { ...base, dishes: [rice, soup], limitVnd: 1_000_000 },
      total: 84_000,
      fits: true,
      trimmed: 0,
      days: [["Rice and egg"], ["Soup"], ["Rice and egg"], ["Soup"]],
    },
    {
      name: "exactly at the limit fits",
      input: { ...base, dishes: [rice], limitVnd: 40_000 },
      total: 40_000,
      fits: true,
      trimmed: 0,
      days: [["Rice and egg"], ["Rice and egg"], ["Rice and egg"], ["Rice and egg"]],
    },
    {
      name: "one VND over drops the last meal",
      input: { ...base, dishes: [rice], limitVnd: 39_999 },
      total: 30_000,
      fits: true,
      trimmed: 1,
      days: [["Rice and egg"], ["Rice and egg"], ["Rice and egg"], []],
    },
    {
      name: "limit zero keeps nothing",
      input: { ...base, dishes: [rice], limitVnd: 0 },
      total: 0,
      fits: true,
      trimmed: 4,
      days: [[], [], [], []],
    },
    {
      name: "two meals per day",
      input: {
        days: 2,
        mealsPerDay: 2,
        estimateEnabled: true,
        dishes: [rice, soup],
        limitVnd: 1_000_000,
      },
      total: 84_000,
      fits: true,
      trimmed: 0,
      days: [
        ["Rice and egg", "Soup"],
        ["Rice and egg", "Soup"],
      ],
    },
  ];
  it.each(cases)("$name", ({ input, total, fits, trimmed, days }) => {
    const r = generateWeeklyMenu(input);
    expect(r.menu.map((d) => d.dishes)).toEqual(days);
    expect(r.menu.map((d) => d.day)).toEqual(days.map((_, i) => i + 1));
    expect(r.totalEstimateVnd).toBe(total);
    expect(r.fits).toBe(fits);
    expect(r.trimmedMeals).toBe(trimmed);
    expect(r.shoppingList.reduce((s, l) => s + (l.estimatedCostVnd ?? 0), 0)).toBe(total);
  });

  it("aggregates the shopping list by normalized name and unit", () => {
    const r = generateWeeklyMenu({ ...base, days: 2, dishes: [rice, soup], limitVnd: 1_000_000 });
    expect(r.shoppingList).toEqual([
      { name: "rice", unit: "g", quantity: 300, estimatedCostVnd: 6_000 },
      { name: "egg", unit: "pc", quantity: 2, estimatedCostVnd: 6_000 },
      { name: "pork", unit: "g", quantity: 150, estimatedCostVnd: 30_000 },
    ]);
  });

  it("without estimates nothing is priced or trimmed", () => {
    const r = generateWeeklyMenu({ ...base, estimateEnabled: false, dishes: [rice], limitVnd: 1 });
    expect(r.totalEstimateVnd).toBeNull();
    expect(r.fits).toBeNull();
    expect(r.trimmedMeals).toBe(0);
    expect(r.shoppingList.every((l) => l.estimatedCostVnd === null)).toBe(true);
  });

  it("is deterministic and defaults are exposed", () => {
    const input = { ...base, dishes: [rice, soup], limitVnd: 50_000 };
    expect(generateWeeklyMenu(input)).toEqual(generateWeeklyMenu(input));
    expect(DEFAULT_MENU_DAYS).toBe(7);
    expect(DEFAULT_MEALS_PER_DAY).toBe(1);
  });
});

const oneIngredient = (patch: Record<string, unknown>) => ({
  weekIndex: 1,
  dishes: [
    { name: "a", ingredients: [{ name: "x", unit: "g", quantity: 1, unitPriceVnd: 1, ...patch }] },
  ],
});

describe("parseMenuRequest (untrusted input)", () => {
  it("accepts a valid body", () => {
    expect(parseMenuRequest({ weekIndex: 1, dishes: [rice] })).toMatchObject({ weekIndex: 1 });
  });
  const bad = [
    { name: "no dishes", body: { weekIndex: 1, dishes: [] } },
    { name: "bad week", body: { weekIndex: 0, dishes: [rice] } },
    { name: "float price", body: oneIngredient({ unitPriceVnd: 1.5 }) },
    { name: "negative price", body: oneIngredient({ unitPriceVnd: -1 }) },
    { name: "zero quantity", body: oneIngredient({ quantity: 0 }) },
    { name: "empty dish name", body: { weekIndex: 1, dishes: [{ name: " ", ingredients: [] }] } },
    { name: "days 0", body: { weekIndex: 1, dishes: [rice], days: 0 } },
    { name: "not an object", body: "x" },
  ];
  it.each(bad)("rejects $name", ({ body }) => {
    expect(parseMenuRequest(body)).toBeUndefined();
  });
});

describe("weekly menu routes", () => {
  const headers = { "x-user-id": "u1" };
  const NOW = new Date("2026-03-02T00:00:00Z");

  it("generates a menu and shopping list within the food weekly limit", async () => {
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
    const app = await createApp(config, { store, now: () => NOW });
    const res = await app.inject({
      method: "POST",
      url: "/budget/weekly-menu",
      headers,
      payload: { weekIndex: 1, dishes: [rice, soup] },
    });
    expect(res.statusCode).toBe(201);
    const data = res.json().data;
    expect(data.menu).toHaveLength(7);
    expect(data.limitVnd).toBeGreaterThan(0);
    expect(data.fits).toBe(true);
    expect(data.totalEstimateVnd).toBeLessThanOrEqual(data.limitVnd);
    expect(data.shoppingList.length).toBeGreaterThan(0);

    // A tiny food limit forces trimming by code.
    const food = store.get("u1")!.categories.find((c) => c.key === "food")!;
    food.cycleLimitVnd = 0;
    const tight = await app.inject({
      method: "POST",
      url: "/budget/weekly-menu",
      headers,
      payload: { weekIndex: 2, dishes: [rice] },
    });
    expect(tight.json().data).toMatchObject({ limitVnd: 0, totalEstimateVnd: 0, fits: true });

    const got = await app.inject({
      method: "GET",
      url: "/budget/weekly-menu?weekIndex=1",
      headers,
    });
    expect(got.json().data.totalEstimateVnd).toBe(data.totalEstimateVnd);
    const missing = await app.inject({
      method: "GET",
      url: "/budget/weekly-menu?weekIndex=3",
      headers,
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it("rejects anonymous calls and invalid bodies; 404 without a cycle", async () => {
    const app = await createApp(config);
    expect(
      (await app.inject({ method: "POST", url: "/budget/weekly-menu", payload: {} })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: "POST", url: "/budget/weekly-menu", headers, payload: {} }))
        .statusCode,
    ).toBe(400);
    const none = await app.inject({
      method: "POST",
      url: "/budget/weekly-menu",
      headers,
      payload: { weekIndex: 1, dishes: [rice] },
    });
    expect(none.statusCode).toBe(404);
    await app.close();
  });
});
