import {
  SETTINGS,
  SurplusTargetSchema,
  type EventEnvelope,
  type SettingKey,
  type SurplusAllocation,
} from "@my-wife/contracts";
import type { SampleBudgetRecord, SampleBudgetStore } from "./onboarding";
import { contingencyBalanceOf, CONTINGENCY_SHORT_CODE } from "./exceptions";
import { getCategoryBalances } from "./transactions";
import { settleLastWeekExcess } from "./overspend";

/** The surplus split of a closed cycle with the flags of its two events. */
export interface CycleCloseRecord {
  cycleId: string;
  allocation: SurplusAllocation;
  closedAt: string;
  /** False until `surplus.allocated` was published, so a failed publish is retried. */
  surplusAnnounced: boolean;
  /** False until `cycle.closed` was published. */
  cycleAnnounced: boolean;
}

type Settings = Partial<Record<SettingKey, unknown>>;

/**
 * Pure: surplus at cycle end (spec 10 section 8) = sum of positive remainders (limit minus net
 * spending) of variable categories with `countsTowardSurplus` on. Fixed categories never
 * contribute. The contingency fund remainder is its balance after exceptions funded from it.
 */
export function surplusTotalVnd(record: SampleBudgetRecord): number {
  const balances = new Map(getCategoryBalances(record).map((b) => [b.categoryId, b.balanceVnd]));
  let total = 0;
  for (const c of record.categories) {
    if (!c.countsTowardSurplus || c.kind === "fixed") continue;
    const remainder =
      c.shortCode === CONTINGENCY_SHORT_CODE
        ? contingencyBalanceOf(record)
        : (balances.get(c.id) ?? 0);
    total += Math.max(0, remainder);
  }
  return total;
}

/**
 * Pure: splits `totalVnd` by whole percentages. Each share is rounded down to a whole VND; the
 * remainder takes every leftover VND, so the three parts always sum to the total exactly.
 */
export function splitSurplus(
  totalVnd: number,
  savingsPercent: number,
  futurePurchasesPercent: number,
): { savingsVnd: number; futurePurchasesVnd: number; remainderVnd: number } {
  const savingsVnd = Math.floor((totalVnd * savingsPercent) / 100);
  const futurePurchasesVnd = Math.floor((totalVnd * futurePurchasesPercent) / 100);
  return {
    savingsVnd,
    futurePurchasesVnd,
    remainderVnd: totalVnd - savingsVnd - futurePurchasesVnd,
  };
}

const percent = (raw: unknown): number | undefined =>
  typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 100 ? raw : undefined;

/** The user's split settings; invalid values, or shares above 100 together, use the defaults. */
export function surplusSettings(settings: Settings) {
  const defSavings = SETTINGS["budget.surplus_share_savings_percent"].default;
  const defFuture = SETTINGS["budget.surplus_share_future_purchases_percent"].default;
  let savings = percent(settings["budget.surplus_share_savings_percent"]) ?? defSavings;
  let future = percent(settings["budget.surplus_share_future_purchases_percent"]) ?? defFuture;
  if (savings + future > 100) {
    savings = defSavings;
    future = defFuture;
  }
  const target = SurplusTargetSchema.safeParse(settings["budget.surplus_remainder_target"]);
  return {
    savingsPercent: savings,
    futurePurchasesPercent: future,
    remainderTarget: target.success
      ? target.data
      : SETTINGS["budget.surplus_remainder_target"].default,
  };
}

export type CloseCycleResult =
  | { ok: true; data: SurplusAllocation }
  | { ok: false; error: { code: "budget.cycle_not_found" | "budget.cycle_not_closing" } };

export interface CycleCloserDeps {
  store: SampleBudgetStore;
  /** Time is a parameter so tests can simulate it. */
  now: () => Date;
  publish: (event: EventEnvelope) => void | Promise<void>;
  readSettings?: (userId: string) => Promise<Settings>;
  /**
   * Categories of the user's next cycle, when it exists. The last-week excess of the closing
   * cycle is deducted from the first week of the same category there (matched by short code);
   * without a next cycle, or without that category, it stays penalty debt (spec 10 section 8).
   */
  findNextCycleCategories?: (
    userId: string,
  ) => Promise<{ categoryId: string; shortCode: string }[] | undefined>;
}

/**
 * Splits the surplus of a `closing` cycle by the user's ratios and closes the cycle. The split,
 * the state change and an audit record are stored atomically once per cycle; then
 * `surplus.allocated` and `cycle.closed` are published (deterministic ids). A failed publish is
 * retried by the next call, never by allocating twice. A closed cycle is never edited.
 */
export function createCycleCloser(deps: CycleCloserDeps) {
  const announce = async (
    userId: string,
    cycleId: string,
  ): Promise<SurplusAllocation | undefined> => {
    const record = await deps.store.find(userId);
    const close = record?.cycleCloses.find((c) => c.cycleId === cycleId);
    if (!close) return undefined;
    if (!close.surplusAnnounced) {
      await deps.publish({
        id: `surplus-allocated-${cycleId}`,
        type: "surplus.allocated",
        occurredAt: close.closedAt,
        userId,
        schemaVersion: 1,
        payload: close.allocation,
      } as EventEnvelope);
      await deps.store.markCycleCloseAnnounced(userId, cycleId, "surplus");
    }
    if (!close.cycleAnnounced) {
      await deps.publish({
        id: `cycle-closed-${cycleId}`,
        type: "cycle.closed",
        occurredAt: close.closedAt,
        userId,
        schemaVersion: 1,
        payload: { cycleId, surplus: close.allocation },
      } as EventEnvelope);
      await deps.store.markCycleCloseAnnounced(userId, cycleId, "cycle");
    }
    return close.allocation;
  };

  return async function closeCycle(userId: string): Promise<CloseCycleResult> {
    const record = await deps.store.find(userId);
    if (!record) return { ok: false, error: { code: "budget.cycle_not_found" } };
    const cycleId = record.cycle.id;
    if (record.cycle.state === "closed") {
      const allocation = await announce(userId, cycleId);
      if (allocation) return { ok: true, data: allocation };
    }
    if (record.cycle.state !== "closing") {
      return { ok: false, error: { code: "budget.cycle_not_closing" } };
    }
    const cfg = surplusSettings((await deps.readSettings?.(userId)) ?? {});
    const totalVnd = surplusTotalVnd(record);
    const allocation: SurplusAllocation = {
      cycleId,
      totalVnd,
      ...splitSurplus(totalVnd, cfg.savingsPercent, cfg.futurePurchasesPercent),
      remainderTarget: cfg.remainderTarget,
    };
    const settlement = settleLastWeekExcess(
      record.penaltyDebts.filter((d) => d.cycleId === cycleId),
      record.categories.map((c) => ({ categoryId: c.id, shortCode: c.shortCode })),
      await deps.findNextCycleCategories?.(userId),
    );
    const stored = await deps.store.closeCycle(userId, cycleId, allocation, deps.now(), settlement);
    if (stored === "not_closing") return { ok: false, error: { code: "budget.cycle_not_closing" } };
    const announced = await announce(userId, cycleId);
    return { ok: true, data: announced ?? allocation };
  };
}
