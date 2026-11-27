import {
  GetSettingsResponseSchema,
  SETTINGS,
  WishlistItemSchema,
  type BudgetOverviewResponse,
  type SurplusAllocation,
} from "@my-wife/contracts";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type CloseOverview = Extract<BudgetOverviewResponse, { ok: true }>["data"];

export type CloseSettings = Record<string, unknown>;

/** Settings that drive this page; every number is a user setting with a registry default. */
export const CLOSE_SETTING_KEYS = [
  "budget.surplus_share_savings_percent",
  "budget.surplus_share_future_purchases_percent",
  "budget.surplus_remainder_target",
  "budget.exceptions_per_cycle",
  "plan.menu_estimate_enabled",
] as const;

export type ProjectedSurplus = Omit<SurplusAllocation, "cycleId">;

const setting = (values: CloseSettings, key: (typeof CLOSE_SETTING_KEYS)[number]): unknown =>
  values[key] ?? SETTINGS[key].default;

/**
 * Preview of the surplus split (spec 10 section 8): positive remainders (cycle limit minus net
 * spending) of variable categories that count toward surplus, split by the user's percentages.
 * The remainder takes the leftover VND, so the three parts sum to the total. The budget service
 * has no read endpoint for the booked split yet, so this is a projection, not the booked amount.
 */
export function projectSurplus(overview: CloseOverview, values: CloseSettings): ProjectedSurplus {
  const net = new Map<string, number>();
  for (const t of overview.transactions) {
    if (t.categoryId === null) continue;
    const signed = t.direction === "out" ? t.amountVnd : -t.amountVnd;
    net.set(t.categoryId, (net.get(t.categoryId) ?? 0) + signed);
  }
  let totalVnd = 0;
  for (const { category: c } of overview.categories) {
    if (!c.countsTowardSurplus || c.kind === "fixed") continue;
    totalVnd += Math.max(0, c.cycleLimitVnd - (net.get(c.id) ?? 0));
  }
  const savings = Number(setting(values, "budget.surplus_share_savings_percent"));
  const future = Number(setting(values, "budget.surplus_share_future_purchases_percent"));
  const savingsVnd = Math.floor((totalVnd * savings) / 100);
  const futurePurchasesVnd = Math.floor((totalVnd * future) / 100);
  return {
    totalVnd,
    savingsVnd,
    futurePurchasesVnd,
    remainderVnd: totalVnd - savingsVnd - futurePurchasesVnd,
    remainderTarget:
      setting(values, "budget.surplus_remainder_target") === "future_purchases"
        ? "future_purchases"
        : "savings",
  };
}

/** Exceptions the user may claim per cycle (`budget.exceptions_per_cycle`). */
export function exceptionsPerCycle(values: CloseSettings): number {
  const n = Number(setting(values, "budget.exceptions_per_cycle"));
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/** Reads this page's settings; unreadable values fall back to the registry defaults. */
export async function loadCloseSettings(doFetch: FetchLike = fetch): Promise<CloseSettings> {
  try {
    const res = await doFetch("/api/settings", { cache: "no-store" });
    if (!res.ok) return {};
    const parsed = GetSettingsResponseSchema.safeParse(await res.json());
    return parsed.success && parsed.data.ok ? parsed.data.data.values : {};
  } catch {
    return {};
  }
}

export interface WishlistRow {
  id: string;
  name: string;
  priceVnd: number;
  savedVnd: number;
  progressPercent: number;
}

export type WishlistResult =
  { status: "ready"; items: WishlistRow[] } | { status: "empty" } | { status: "error" };

/** Reads the wishlist with progress from the future-purchases savings. */
export async function loadWishlist(doFetch: FetchLike = fetch): Promise<WishlistResult> {
  try {
    const res = await doFetch("/api/budget/wishlist", { cache: "no-store" });
    if (!res.ok) return { status: "error" };
    const body = (await res.json()) as { ok?: boolean; data?: { items?: unknown[] } };
    if (!body.ok || !Array.isArray(body.data?.items)) return { status: "error" };
    const items: WishlistRow[] = [];
    for (const raw of body.data.items) {
      const parsed = WishlistItemSchema.safeParse(raw);
      if (!parsed.success) return { status: "error" };
      const extra = raw as { progressPercent?: unknown; bought?: unknown };
      if (extra.bought === true) continue;
      const { priceVnd, savedVnd } = parsed.data;
      items.push({
        ...parsed.data,
        progressPercent:
          typeof extra.progressPercent === "number"
            ? extra.progressPercent
            : priceVnd === 0
              ? 100
              : Math.min(100, Math.floor((savedVnd * 100) / priceVnd)),
      });
    }
    return items.length === 0 ? { status: "empty" } : { status: "ready", items };
  } catch {
    return { status: "error" };
  }
}

export interface WeeklyMenuData {
  weekIndex: number;
  menu: { day: number; dishes: string[] }[];
  shoppingList: { name: string; unit: string; quantity: number; estimatedCostVnd: number | null }[];
  limitVnd: number;
  totalEstimateVnd: number | null;
  fits: boolean | null;
  trimmedMeals: number;
}

export type MenuResult =
  { status: "ready"; menu: WeeklyMenuData } | { status: "empty" } | { status: "error" };

/** Reads the proposed weekly menu; no menu yet is an empty state, not an error. */
export async function loadWeeklyMenu(
  weekIndex: number,
  doFetch: FetchLike = fetch,
): Promise<MenuResult> {
  try {
    const res = await doFetch(`/api/budget/weekly-menu?weekIndex=${weekIndex}`, {
      cache: "no-store",
    });
    if (res.status === 404) return { status: "empty" };
    if (!res.ok) return { status: "error" };
    const body = (await res.json()) as { ok?: boolean; data?: WeeklyMenuData };
    const data = body.data;
    if (!body.ok || !data || !Array.isArray(data.menu) || !Array.isArray(data.shoppingList)) {
      return { status: "error" };
    }
    return { status: "ready", menu: data };
  } catch {
    return { status: "error" };
  }
}

export type ClaimState =
  | { state: "idle" }
  | { state: "busy" }
  | { state: "done"; remaining: number }
  | { state: "failed"; code: string };

/** Claims an exception for a category of the current week; the budget service decides. */
export async function claimException(
  categoryId: string,
  weekIndex: number,
  doFetch: FetchLike = fetch,
): Promise<ClaimState> {
  try {
    const res = await doFetch("/api/budget/exceptions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ categoryId, weekIndex }),
    });
    const body = (await res.json()) as {
      ok?: boolean;
      data?: { remainingExceptions?: number };
      error?: { code?: string };
    };
    if (res.ok && body.ok) return { state: "done", remaining: body.data?.remainingExceptions ?? 0 };
    return { state: "failed", code: body.error?.code ?? "unknown" };
  } catch {
    return { state: "failed", code: "unknown" };
  }
}
