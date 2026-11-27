import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../locales/en.json";
import vi from "../locales/vi.json";
import { CycleCloseView } from "../components/cycle-close-view";
import {
  claimException,
  loadWeeklyMenu,
  loadWishlist,
  projectSurplus,
  type CloseOverview,
} from "../lib/cycle-close";
import { NAV_ITEMS } from "../lib/nav";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const cat = (id: string, over: Record<string, unknown>) => ({
  id,
  kind: "variable",
  countsTowardSurplus: true,
  cycleLimitVnd: 1_000_000,
  name: id,
  ...over,
});
const tx = (categoryId: string, amountVnd: number, direction = "out") => ({
  categoryId,
  amountVnd,
  direction,
});
const overview = {
  cycle: { id: "c1", state: "closing" },
  weekIndex: 4,
  categories: [
    { category: cat("food", {}) },
    { category: cat("fun", { cycleLimitVnd: 500_000 }) },
    { category: cat("rent", { kind: "fixed", cycleLimitVnd: 3_000_000 }) },
    { category: cat("over", { cycleLimitVnd: 100_000 }) },
    { category: cat("off", { countsTowardSurplus: false }) },
  ],
  transactions: [
    tx("food", 400_000),
    tx("over", 150_000),
    tx("fun", 100_000),
    tx("fun", 50_000, "in"),
  ],
} as unknown as CloseOverview;
const settings = {
  "budget.surplus_share_savings_percent": 30,
  "budget.surplus_share_future_purchases_percent": 20,
  "budget.surplus_remainder_target": "savings",
  "budget.exceptions_per_cycle": 2,
  "plan.menu_estimate_enabled": true,
};

describe("projectSurplus", () => {
  it("sums positive remainders of variable surplus categories and splits exactly", () => {
    const s = projectSurplus(overview, settings);
    // food 600k + fun 450k + off 1M is excluded; over is negative; fixed is excluded
    expect(s.totalVnd).toBe(600_000 + 450_000);
    expect(s.savingsVnd + s.futurePurchasesVnd + s.remainderVnd).toBe(s.totalVnd);
    expect(s.savingsVnd).toBe(Math.floor((s.totalVnd * 30) / 100));
    expect(s.remainderTarget).toBe("savings");
  });
});

const wishlist = [
  { id: "w1", name: "Laptop", priceVnd: 10_000_000, savedVnd: 2_500_000, progressPercent: 25 },
];
const menu = {
  weekIndex: 4,
  menu: [{ day: 1, dishes: ["Pho"] }],
  shoppingList: [{ name: "rice", unit: "kg", quantity: 2, estimatedCostVnd: 40_000 }],
  limitVnd: 700_000,
  totalEstimateVnd: 500_000,
  fits: true,
  trimmedMeals: 0,
};

const base = {
  locale: "en",
  status: "ready",
  surplus: projectSurplus(overview, settings),
  exceptionsPerCycle: 2,
  claimable: [{ id: "food", name: "Food" }],
  wishlist: { status: "ready", items: wishlist },
  menu: { status: "ready", menu },
  claim: { state: "idle" },
  onClaim: () => {},
  onRefresh: () => {},
};
const render = (props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(CycleCloseView, { ...base, ...props } as never));

describe("closing cycle page", () => {
  it("shows the surplus split, exceptions and wishlist", () => {
    const html = render({});
    expect(html).toContain(en["cycle_close.surplus.title"]);
    expect(html).toContain("1,050,000 VND");
    expect(html).toContain(en["cycle_close.exceptions.title"]);
    expect(html).toContain("Food");
    expect(html).toContain(en["cycle_close.wishlist.title"]);
    expect(html).toContain("Laptop");
    expect(html).toContain("25%");
    expect(html).toContain(en["cycle_close.menu.title"]);
    expect(html).toContain("rice");
  });

  it("renders loading, empty and error states", () => {
    expect(render({ status: "loading" })).toContain(en["cycle_close.loading"]);
    expect(render({ status: "empty" })).toContain(en["cycle_close.empty"]);
    const err = render({ status: "error" });
    expect(err).toContain(en["cycle_close.error"]);
    expect(err).toContain(en["cycle_close.retry"]);
  });

  it("handles per-section empty and error states", () => {
    const html = render({
      wishlist: { status: "empty" },
      menu: { status: "error" },
      exceptionsPerCycle: 0,
    });
    expect(html).toContain(en["cycle_close.wishlist.empty"]);
    expect(html).toContain(en["cycle_close.menu.error"]);
    expect(html).toContain(en["cycle_close.exceptions.none_allowed"]);
  });

  it("renders Vietnamese and has matching keys and a nav entry", () => {
    expect(render({ locale: "vi" })).toContain(vi["cycle_close.surplus.title"]);
    for (const k of Object.keys(en).filter((key) => key.startsWith("cycle_close."))) {
      expect(vi).toHaveProperty([k]);
    }
    expect(NAV_ITEMS.some((i) => i.href === "/cycle-close")).toBe(true);
  });
});

describe("loaders", () => {
  it("loads the wishlist", async () => {
    expect(
      await loadWishlist(async () => json(200, { ok: true, data: { items: wishlist } })),
    ).toMatchObject({ status: "ready" });
    expect(await loadWishlist(async () => json(200, { ok: true, data: { items: [] } }))).toEqual({
      status: "empty",
    });
    expect(await loadWishlist(async () => json(500, {}))).toEqual({ status: "error" });
  });

  it("loads the weekly menu and treats 404 as empty", async () => {
    expect(await loadWeeklyMenu(4, async () => json(200, { ok: true, data: menu }))).toMatchObject({
      status: "ready",
    });
    expect(await loadWeeklyMenu(4, async () => json(404, { ok: false }))).toEqual({
      status: "empty",
    });
    expect(await loadWeeklyMenu(4, async () => json(500, {}))).toEqual({ status: "error" });
  });

  it("claims an exception and reports the error code", async () => {
    let body = "";
    const ok = await claimException("food", 4, async (_u, init) => {
      body = String(init?.body);
      return json(201, { ok: true, data: { claimId: "x", remainingExceptions: 1 } });
    });
    expect(ok).toEqual({ state: "done", remaining: 1 });
    expect(JSON.parse(body)).toEqual({ categoryId: "food", weekIndex: 4 });
    expect(
      await claimException("food", 4, async () =>
        json(409, { ok: false, error: { code: "budget.exception_limit_reached" } }),
      ),
    ).toEqual({ state: "failed", code: "budget.exception_limit_reached" });
  });
});
