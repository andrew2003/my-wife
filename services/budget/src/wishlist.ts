/** A wishlist item as stored (spec 10 section 10). `savedVnd` is derived, never stored. */
export interface WishlistEntry {
  id: string;
  name: string;
  priceVnd: number;
  createdAt: string;
  boughtAt: string | null;
}

export interface WishlistAudit {
  at: string;
  userId: string;
  action: "wishlist_item_added" | "wishlist_item_bought";
  detail: Record<string, string | number>;
}

export interface WishlistView {
  id: string;
  name: string;
  priceVnd: number;
  savedVnd: number;
  progressPercent: number;
  funded: boolean;
  bought: boolean;
  boughtAt: string | null;
  /** Estimated cycles left; null when the contribution is 0 ("unknown"). */
  cyclesRemaining: number | null;
}

/** Port for wishlist persistence; an item and its audit record are written together. */
export interface WishlistStore {
  list(userId: string): Promise<WishlistEntry[]>;
  add(userId: string, entry: WishlistEntry, audit: WishlistAudit): Promise<void>;
  markBought(
    userId: string,
    id: string,
    boughtAt: string,
    audit: WishlistAudit,
  ): Promise<"bought" | "not_found" | "already_bought">;
}

export class MemoryWishlistStore implements WishlistStore {
  private readonly items = new Map<string, WishlistEntry[]>();
  readonly audit: WishlistAudit[] = [];

  async list(userId: string) {
    return (this.items.get(userId) ?? []).map((e) => ({ ...e }));
  }

  async add(userId: string, entry: WishlistEntry, audit: WishlistAudit) {
    this.items.set(userId, [...(this.items.get(userId) ?? []), { ...entry }]);
    this.audit.push(audit);
  }

  async markBought(userId: string, id: string, boughtAt: string, audit: WishlistAudit) {
    const entry = this.items.get(userId)?.find((e) => e.id === id);
    if (!entry) return "not_found" as const;
    if (entry.boughtAt) return "already_bought" as const;
    entry.boughtAt = boughtAt;
    this.audit.push(audit);
    return "bought" as const;
  }
}

/**
 * Pure: spreads the future-purchases savings pool over the items in the order they were added.
 * A bought item has used up its price (capped at what the pool holds); an open item takes what is
 * left up to its price.
 */
export function allocateSavings(
  entries: readonly WishlistEntry[],
  poolVnd: number,
): (WishlistEntry & { savedVnd: number; progressPercent: number; funded: boolean })[] {
  let remaining = Math.max(0, poolVnd);
  return entries.map((e) => {
    if (e.boughtAt) {
      remaining = Math.max(0, remaining - e.priceVnd);
      return { ...e, savedVnd: e.priceVnd, progressPercent: 100, funded: true };
    }
    const savedVnd = Math.min(e.priceVnd, remaining);
    remaining -= savedVnd;
    return {
      ...e,
      savedVnd,
      progressPercent: Math.floor((savedVnd * 100) / e.priceVnd),
      funded: savedVnd >= e.priceVnd,
    };
  });
}

/** Pure: `ceil((price - saved) / contribution)`; null (unknown) when the contribution is 0. */
export function estimateCyclesRemaining(
  priceVnd: number,
  savedVnd: number,
  contributionVnd: number,
): number | null {
  const missing = Math.max(0, priceVnd - savedVnd);
  if (missing === 0) return 0;
  if (contributionVnd <= 0) return null;
  return Math.ceil(missing / contributionVnd);
}

/** Pure: average funding over completed cycles (rounded down), or the planned amount before any. */
export function averageContributionVnd(completed: readonly number[], plannedVnd: number): number {
  if (completed.length === 0) return Math.max(0, plannedVnd);
  return Math.floor(completed.reduce((a, b) => a + b, 0) / completed.length);
}

export interface WishlistPool {
  /** Total future-purchases money accumulated (surplus shares of closed cycles). */
  savedPoolVnd: number;
  /** Future-purchases funding of each completed cycle. */
  completedContributionsVnd: number[];
  /** Planned amount of the future-purchases category, used before any cycle completed. */
  plannedVnd: number;
}

export interface WishlistDeps {
  store: WishlistStore;
  now: () => Date;
  newId: () => string;
  readPool: (userId: string) => Promise<WishlistPool>;
}

function parseAddItem(request: unknown): { name: string; priceVnd: number } | null {
  if (typeof request !== "object" || request === null) return null;
  const { name, priceVnd } = request as Record<string, unknown>;
  if (typeof name !== "string" || name.trim() === "") return null;
  if (typeof priceVnd !== "number" || !Number.isSafeInteger(priceVnd) || priceVnd <= 0) return null;
  return { name: name.trim(), priceVnd };
}

type ErrorCode =
  | "budget.invalid_wishlist_item"
  | "budget.wishlist_item_not_found"
  | "budget.wishlist_already_bought"
  | "budget.wishlist_not_funded";

export type WishlistResult<T> = { ok: true; data: T } | { ok: false; error: { code: ErrorCode } };

export function createWishlist(deps: WishlistDeps) {
  async function views(userId: string): Promise<WishlistView[]> {
    const [entries, pool] = await Promise.all([deps.store.list(userId), deps.readPool(userId)]);
    const contribution = averageContributionVnd(pool.completedContributionsVnd, pool.plannedVnd);
    return allocateSavings(entries, pool.savedPoolVnd).map((e) => ({
      id: e.id,
      name: e.name,
      priceVnd: e.priceVnd,
      savedVnd: e.savedVnd,
      progressPercent: e.progressPercent,
      funded: e.funded,
      bought: e.boughtAt !== null,
      boughtAt: e.boughtAt,
      cyclesRemaining: estimateCyclesRemaining(e.priceVnd, e.savedVnd, contribution),
    }));
  }

  async function list(userId: string): Promise<WishlistResult<{ items: WishlistView[] }>> {
    return { ok: true, data: { items: await views(userId) } };
  }

  async function add(userId: string, request: unknown): Promise<WishlistResult<WishlistView>> {
    const parsed = parseAddItem(request);
    if (!parsed) return { ok: false, error: { code: "budget.invalid_wishlist_item" } };
    const at = deps.now().toISOString();
    const entry: WishlistEntry = {
      id: deps.newId(),
      name: parsed.name,
      priceVnd: parsed.priceVnd,
      createdAt: at,
      boughtAt: null,
    };
    await deps.store.add(userId, entry, {
      at,
      userId,
      action: "wishlist_item_added",
      detail: { itemId: entry.id, priceVnd: entry.priceVnd },
    });
    const view = (await views(userId)).find((v) => v.id === entry.id)!;
    return { ok: true, data: view };
  }

  async function markBought(userId: string, id: string): Promise<WishlistResult<WishlistView>> {
    const current = (await views(userId)).find((v) => v.id === id);
    if (!current) return { ok: false, error: { code: "budget.wishlist_item_not_found" } };
    if (current.bought) return { ok: false, error: { code: "budget.wishlist_already_bought" } };
    if (!current.funded) return { ok: false, error: { code: "budget.wishlist_not_funded" } };
    const at = deps.now().toISOString();
    const outcome = await deps.store.markBought(userId, id, at, {
      at,
      userId,
      action: "wishlist_item_bought",
      detail: { itemId: id, priceVnd: current.priceVnd },
    });
    if (outcome === "not_found")
      return { ok: false, error: { code: "budget.wishlist_item_not_found" } };
    if (outcome === "already_bought")
      return { ok: false, error: { code: "budget.wishlist_already_bought" } };
    return { ok: true, data: (await views(userId)).find((v) => v.id === id)! };
  }

  return { list, add, markBought };
}

/** Short code of the future-purchases `fund` category in the sample budget (see decisions.md). */
export const FUTURE_PURCHASES_SHORT_CODE = "TL";

/**
 * Pure: the future-purchases funding of a budget record. Each closed cycle contributes the
 * category's cycle limit plus the surplus share allocated to future purchases.
 */
export function readWishlistPool(
  record:
    | {
        categories: { shortCode: string; cycleLimitVnd: number }[];
        cycleCloses: { allocation: { futurePurchasesVnd: number } }[];
      }
    | undefined,
): WishlistPool {
  const limit =
    record?.categories.find((c) => c.shortCode === FUTURE_PURCHASES_SHORT_CODE)?.cycleLimitVnd ?? 0;
  const completed = (record?.cycleCloses ?? []).map((c) => limit + c.allocation.futurePurchasesVnd);
  return {
    savedPoolVnd: completed.reduce((a, b) => a + b, 0),
    completedContributionsVnd: completed,
    plannedVnd: limit,
  };
}
