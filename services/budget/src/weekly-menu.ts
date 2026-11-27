import type { SampleBudgetStore } from "./onboarding";
import { effectiveWeeklyLimit } from "./overspend";
import { roundingFrom } from "./overview";
import { buildWeeklyLimitPlan } from "./weekly-plan";
import type { SettingKey } from "@my-wife/contracts";

/** Service-level defaults; callers may override them per request. */
export const DEFAULT_MENU_DAYS = 7;
export const DEFAULT_MEALS_PER_DAY = 1;
/** Stable key of the food category in the sample budget. */
export const FOOD_CATEGORY_KEY = "food";

export interface MenuIngredient {
  name: string;
  unit: string;
  /** Positive integer, in `unit`. */
  quantity: number;
  /** Integer VND per unit; a user entry or an LLM proposal the user approved. */
  unitPriceVnd: number;
}

export interface MenuDish {
  name: string;
  ingredients: MenuIngredient[];
}

export interface MenuInput {
  dishes: readonly MenuDish[];
  days: number;
  mealsPerDay: number;
  /** Setting `plan.menu_estimate_enabled`. When false nothing is priced or trimmed. */
  estimateEnabled: boolean;
  /** Weekly limit of the food category, integer VND. */
  limitVnd: number;
}

export interface MenuDay {
  day: number;
  dishes: string[];
}

export interface ShoppingLine {
  name: string;
  unit: string;
  quantity: number;
  estimatedCostVnd: number | null;
}

export interface WeeklyMenu {
  menu: MenuDay[];
  shoppingList: ShoppingLine[];
  limitVnd: number;
  /** Null when estimates are disabled. */
  totalEstimateVnd: number | null;
  /** Null when estimates are disabled. */
  fits: boolean | null;
  /** Meals removed from the end of the week so that the estimate fits the limit. */
  trimmedMeals: number;
}

const normalizeName = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

const dishCost = (d: MenuDish) =>
  d.ingredients.reduce((sum, i) => sum + i.quantity * i.unitPriceVnd, 0);

/**
 * Pure: spreads the dishes over the days in the user's order (round robin), drops meals from the
 * end of the week until the estimate fits the limit, and builds the aggregated shopping list.
 * The decision is made by code; any price or dish suggested by an LLM is only an input.
 */
export function generateWeeklyMenu(input: MenuInput): WeeklyMenu {
  const { dishes, days, mealsPerDay, estimateEnabled, limitVnd } = input;
  if (dishes.length === 0) throw new RangeError("dishes must not be empty");
  for (const [name, v, min] of [
    ["days", days, 1],
    ["mealsPerDay", mealsPerDay, 1],
    ["limitVnd", limitVnd, 0],
  ] as const) {
    if (!Number.isSafeInteger(v) || v < min) throw new RangeError(`${name} is out of range`);
  }

  let slots = Array.from({ length: days * mealsPerDay }, (_, i) => dishes[i % dishes.length]!);
  const total = (s: readonly MenuDish[]) => s.reduce((sum, d) => sum + dishCost(d), 0);
  let trimmedMeals = 0;
  if (estimateEnabled) {
    let sum = total(slots);
    while (sum > limitVnd && slots.length > 0) {
      sum -= dishCost(slots[slots.length - 1]!);
      slots = slots.slice(0, -1);
      trimmedMeals += 1;
    }
  }

  const menu: MenuDay[] = Array.from({ length: days }, (_, i) => ({ day: i + 1, dishes: [] }));
  slots.forEach((d, i) => menu[Math.floor(i / mealsPerDay)]!.dishes.push(d.name));

  const lines = new Map<string, ShoppingLine>();
  for (const dish of slots) {
    for (const ing of dish.ingredients) {
      const name = normalizeName(ing.name);
      const unit = normalizeName(ing.unit);
      const key = `${name}\u0000${unit}`;
      const cost = estimateEnabled ? ing.quantity * ing.unitPriceVnd : null;
      const line = lines.get(key);
      if (line) {
        line.quantity += ing.quantity;
        if (cost !== null) line.estimatedCostVnd = (line.estimatedCostVnd ?? 0) + cost;
      } else {
        lines.set(key, { name, unit, quantity: ing.quantity, estimatedCostVnd: cost });
      }
    }
  }

  const totalEstimateVnd = estimateEnabled ? total(slots) : null;
  return {
    menu,
    shoppingList: [...lines.values()],
    limitVnd,
    totalEstimateVnd,
    fits: totalEstimateVnd === null ? null : totalEstimateVnd <= limitVnd,
    trimmedMeals,
  };
}

export interface MenuRequest {
  weekIndex: number;
  dishes: MenuDish[];
  days: number;
  mealsPerDay: number;
}

const isPosInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 1;

/** Validates an untrusted body (money and quantities are integers); undefined when invalid. */
export function parseMenuRequest(body: unknown): MenuRequest | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const r = body as Record<string, unknown>;
  if (!isPosInt(r.weekIndex)) return undefined;
  const days = r.days === undefined ? DEFAULT_MENU_DAYS : r.days;
  const mealsPerDay = r.mealsPerDay === undefined ? DEFAULT_MEALS_PER_DAY : r.mealsPerDay;
  if (!isPosInt(days) || !isPosInt(mealsPerDay)) return undefined;
  if (!Array.isArray(r.dishes) || r.dishes.length === 0) return undefined;
  const dishes: MenuDish[] = [];
  for (const d of r.dishes as unknown[]) {
    if (typeof d !== "object" || d === null) return undefined;
    const { name, ingredients } = d as Record<string, unknown>;
    if (typeof name !== "string" || name.trim() === "" || !Array.isArray(ingredients)) {
      return undefined;
    }
    const parsed: MenuIngredient[] = [];
    for (const i of ingredients as unknown[]) {
      if (typeof i !== "object" || i === null) return undefined;
      const { name: iName, unit, quantity, unitPriceVnd } = i as Record<string, unknown>;
      if (typeof iName !== "string" || iName.trim() === "") return undefined;
      if (typeof unit !== "string" || unit.trim() === "") return undefined;
      if (!isPosInt(quantity)) return undefined;
      if (
        typeof unitPriceVnd !== "number" ||
        !Number.isSafeInteger(unitPriceVnd) ||
        unitPriceVnd < 0
      ) {
        return undefined;
      }
      parsed.push({ name: iName, unit, quantity, unitPriceVnd });
    }
    dishes.push({ name: name.trim(), ingredients: parsed });
  }
  return { weekIndex: r.weekIndex, dishes, days, mealsPerDay };
}

export interface StoredMenu extends WeeklyMenu {
  cycleId: string;
  weekIndex: number;
  generatedAt: string;
  /** Proposed until the user approves it (approval is a follow-up). */
  status: "proposed";
}

export interface MenuAudit {
  at: string;
  userId: string;
  action: "weekly_menu_generated";
  detail: Record<string, string | number | boolean | null>;
}

/** Port for menu persistence; a menu and its audit record are written together. */
export interface WeeklyMenuStore {
  save(userId: string, menu: StoredMenu, audit: MenuAudit): Promise<void>;
  find(userId: string, cycleId: string, weekIndex: number): Promise<StoredMenu | undefined>;
}

export class MemoryWeeklyMenuStore implements WeeklyMenuStore {
  private readonly menus = new Map<string, StoredMenu>();
  readonly audit: MenuAudit[] = [];

  private key(userId: string, cycleId: string, weekIndex: number) {
    return `${userId}|${cycleId}|${weekIndex}`;
  }

  async save(userId: string, menu: StoredMenu, audit: MenuAudit) {
    this.menus.set(this.key(userId, menu.cycleId, menu.weekIndex), menu);
    this.audit.push(audit);
  }

  async find(userId: string, cycleId: string, weekIndex: number) {
    return this.menus.get(this.key(userId, cycleId, weekIndex));
  }
}

export interface WeeklyMenuDeps {
  store: SampleBudgetStore;
  menus: WeeklyMenuStore;
  now: () => Date;
  readSettings?: (userId: string) => Promise<Partial<Record<SettingKey, unknown>>>;
}

type MenuErrorCode =
  | "invalid_request"
  | "budget.cycle_not_found"
  | "budget.week_out_of_range"
  | "budget.food_category_not_found"
  | "budget.menu_not_found";

export type MenuResult =
  { ok: true; data: StoredMenu } | { ok: false; error: { code: MenuErrorCode } };

export function createWeeklyMenuService(deps: WeeklyMenuDeps) {
  async function generate(userId: string, body: unknown): Promise<MenuResult> {
    const req = parseMenuRequest(body);
    if (!req) return { ok: false, error: { code: "invalid_request" } };
    const record = await deps.store.find(userId);
    if (!record) return { ok: false, error: { code: "budget.cycle_not_found" } };
    if (req.weekIndex > record.cycle.weeks) {
      return { ok: false, error: { code: "budget.week_out_of_range" } };
    }
    const food = record.categories.find((c) => c.key === FOOD_CATEGORY_KEY);
    if (!food) return { ok: false, error: { code: "budget.food_category_not_found" } };

    const settings = (await deps.readSettings?.(userId)) ?? {};
    const estimateSetting = settings["plan.menu_estimate_enabled"];
    const estimateEnabled = typeof estimateSetting === "boolean" ? estimateSetting : true;
    const base = buildWeeklyLimitPlan({
      cycleLimitVnd: food.cycleLimitVnd,
      weeks: record.cycle.weeks,
      roundingVnd: roundingFrom(settings),
    })[req.weekIndex - 1]!;
    const limitVnd = effectiveWeeklyLimit(base, food.id, req.weekIndex, record.limitAdjustments);

    const menu = generateWeeklyMenu({
      dishes: req.dishes,
      days: req.days,
      mealsPerDay: req.mealsPerDay,
      estimateEnabled,
      limitVnd,
    });
    const at = deps.now().toISOString();
    const stored: StoredMenu = {
      ...menu,
      cycleId: record.cycle.id,
      weekIndex: req.weekIndex,
      generatedAt: at,
      status: "proposed",
    };
    await deps.menus.save(userId, stored, {
      at,
      userId,
      action: "weekly_menu_generated",
      detail: {
        cycleId: record.cycle.id,
        weekIndex: req.weekIndex,
        limitVnd,
        totalEstimateVnd: menu.totalEstimateVnd,
        trimmedMeals: menu.trimmedMeals,
      },
    });
    return { ok: true, data: stored };
  }

  async function get(userId: string, weekIndex: number): Promise<MenuResult> {
    const record = await deps.store.find(userId);
    if (!record) return { ok: false, error: { code: "budget.cycle_not_found" } };
    const found = await deps.menus.find(userId, record.cycle.id, weekIndex);
    if (!found) return { ok: false, error: { code: "budget.menu_not_found" } };
    return { ok: true, data: found };
  }

  return { generate, get };
}
