import type { CellRejectReason } from "@my-wife/contracts";
import { effectiveWeeklyLimit } from "./overspend";
import { currentWeekIndex } from "./overview";
import type { PlanEdit, SampleBudgetRecord, SampleBudgetStore } from "./onboarding";
import { buildWeeklyLimitPlan } from "./weekly-plan";

/** The five per-cycle tabs of the budget sheet (ADR 0015, spec 41-sync). */
export const BUDGET_SHEET_TABS = [
  "categories",
  "accounts",
  "weeklyPlan",
  "ledger",
  "surplus",
] as const;
export type BudgetSheetTab = (typeof BUDGET_SHEET_TABS)[number];
export const isBudgetSheetTab = (value: unknown): value is BudgetSheetTab =>
  (BUDGET_SHEET_TABS as readonly unknown[]).includes(value);

export interface BudgetSheetCell {
  field: string;
  value: string | number | boolean | null;
  editable: boolean;
}

export interface BudgetSheetRow {
  entityId: string;
  cells: BudgetSheetCell[];
}

/** Plan fields a user may edit, per tab. Every other cell is computed or a booked fact. */
const EDITABLE_FIELDS: Partial<Record<BudgetSheetTab, readonly string[]>> = {
  categories: ["name", "cycleLimitVnd"],
  weeklyPlan: ["amountVnd"],
};

/** A cycle that is closing or closed is never edited directly. */
const cycleIsPast = (record: SampleBudgetRecord): boolean =>
  record.cycle.state === "closing" || record.cycle.state === "closed";

const penaltyId = (cycleId: string, categoryId: string) => `penalty:${cycleId}:${categoryId}`;

/**
 * Pure: the five tabs of the budget sheet at `now`. Only plan cells of an open cycle are
 * editable; transactions, faults, penalties and computed cells are always locked.
 * `roundingVnd` is the user's weekly-limit rounding setting.
 */
export function buildBudgetSheet(
  record: SampleBudgetRecord,
  now: Date,
  roundingVnd: number,
  only?: BudgetSheetTab,
) {
  const { cycle } = record;
  const open = !cycleIsPast(record);
  const weekIndex = currentWeekIndex(cycle.firstDay, cycle.weeks, now);
  const cell = (
    field: string,
    value: BudgetSheetCell["value"],
    editable = false,
  ): BudgetSheetCell => ({ field, value, editable: editable && open });
  const row = (entityId: string, cells: BudgetSheetCell[]): BudgetSheetRow => ({
    entityId,
    cells,
  });
  const accountName = (id: string) => record.accounts.find((a) => a.id === id)?.name ?? null;
  const categoryName = (id: string | null) =>
    record.categories.find((c) => c.id === id)?.name ?? null;

  const tabs: Record<BudgetSheetTab, () => BudgetSheetRow[]> = {
    categories: () =>
      record.categories.map((c) => {
        const base = buildWeeklyLimitPlan({
          cycleLimitVnd: c.cycleLimitVnd,
          weeks: cycle.weeks,
          roundingVnd,
        })[weekIndex - 1]!;
        return row(c.id, [
          cell("name", c.name, true),
          cell("shortCode", c.shortCode),
          cell("priority", c.priority),
          cell("kind", c.kind),
          cell("cycleLimitVnd", c.cycleLimitVnd, true),
          cell(
            "weeklyLimitVnd",
            effectiveWeeklyLimit(base, c.id, weekIndex, record.limitAdjustments),
          ),
          cell("account", accountName(c.bankAccountId)),
        ]);
      }),
    accounts: () =>
      record.accounts.map((a) =>
        row(a.id, [
          cell("name", a.name),
          cell("code", a.code),
          cell("kind", a.kind),
          cell("emailNotificationsConfirmed", a.emailNotificationsConfirmed),
        ]),
      ),
    weeklyPlan: () =>
      record.plannedItems.map((i) =>
        row(i.id, [
          cell("category", categoryName(i.categoryId)),
          cell("number", i.number),
          cell("amountVnd", i.amountVnd, i.status === "planned"),
          cell("transferCode", i.transferCode),
          cell("status", i.status),
        ]),
      ),
    ledger: () => [
      ...[...record.transactions]
        .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
        .map((t) =>
          row(t.id, [
            cell("occurredAt", t.occurredAt),
            cell("direction", t.direction),
            cell("amountVnd", t.amountVnd),
            cell("memo", t.memo),
            cell("category", categoryName(t.categoryId)),
            cell("transactionType", t.transactionType),
            cell("reconciliationResult", t.reconciliationResult),
          ]),
        ),
      ...record.overspends.map((o) =>
        row(o.id, [
          cell("weekIndex", o.weekIndex),
          cell("category", categoryName(o.categoryId)),
          cell("weeklyLimitVnd", o.weeklyLimitVnd),
          cell("spentVnd", o.spentVnd),
          cell("excessVnd", o.excessVnd),
        ]),
      ),
    ],
    surplus: () => [
      ...record.cycleCloses.map((c) =>
        row(`surplus:${c.cycleId}`, [
          cell("totalVnd", c.allocation.totalVnd),
          cell("savingsVnd", c.allocation.savingsVnd),
          cell("futurePurchasesVnd", c.allocation.futurePurchasesVnd),
          cell("remainderVnd", c.allocation.remainderVnd),
          cell("closedAt", c.closedAt),
        ]),
      ),
      ...record.penaltyDebts.map((d) =>
        row(penaltyId(d.cycleId, d.categoryId), [
          cell("category", categoryName(d.categoryId)),
          cell("amountVnd", d.amountVnd),
        ]),
      ),
    ],
  };

  const names = only ? [only] : BUDGET_SHEET_TABS;
  const out: Partial<Record<BudgetSheetTab, BudgetSheetRow[]>> = {};
  for (const name of names) out[name] = tabs[name]();
  return {
    cycle: { id: cycle.id, state: cycle.state, firstDay: cycle.firstDay },
    readOnly: !open,
    tabs: out,
  };
}

export type BudgetEditResult =
  | { status: "applied" }
  | { status: "rejected"; reason: CellRejectReason }
  | { status: "not_found" };

const isVnd = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/**
 * Applies one cell edit. Only plan cells change; booked transactions, faults, penalties and
 * computed cells are refused. The write and its audit record go through the store. Time is a
 * parameter.
 */
export async function applyBudgetCellEdit(
  store: SampleBudgetStore,
  userId: string,
  req: { tab: string; entityId: string; field: string; value: unknown },
  at: Date,
): Promise<BudgetEditResult> {
  const record = await store.find(userId);
  if (!record || !isBudgetSheetTab(req.tab)) return { status: "not_found" };
  const reject = (reason: CellRejectReason): BudgetEditResult => ({ status: "rejected", reason });
  const { entityId, field, value } = req;

  const known: Record<BudgetSheetTab, boolean> = {
    categories: record.categories.some((c) => c.id === entityId),
    accounts: record.accounts.some((a) => a.id === entityId),
    weeklyPlan: record.plannedItems.some((i) => i.id === entityId),
    ledger:
      record.transactions.some((t) => t.id === entityId) ||
      record.overspends.some((o) => o.id === entityId),
    surplus:
      record.cycleCloses.some((c) => `surplus:${c.cycleId}` === entityId) ||
      record.penaltyDebts.some((d) => penaltyId(d.cycleId, d.categoryId) === entityId),
  };
  if (!known[req.tab]) return { status: "not_found" };
  // Booked facts: never writable, whatever the field.
  if (req.tab === "ledger" || req.tab === "surplus") return reject("booked_fact");
  if (cycleIsPast(record)) return reject("past_week");

  if (req.tab === "weeklyPlan") {
    const item = record.plannedItems.find((i) => i.id === entityId)!;
    if (field !== "amountVnd") return reject("locked_cell");
    // A planned item that was matched to a receipt rests on a booked transaction.
    if (item.status !== "planned") return reject("booked_fact");
    if (!isVnd(value)) return reject("validation_failed");
    return finish(
      store,
      userId,
      { kind: "planned_item_amount", itemId: entityId, amountVnd: value },
      at,
    );
  }
  if (req.tab === "accounts" || !EDITABLE_FIELDS[req.tab]?.includes(field)) {
    return reject("locked_cell");
  }
  if (field === "cycleLimitVnd") {
    if (!isVnd(value)) return reject("validation_failed");
    return finish(
      store,
      userId,
      { kind: "category_limit", categoryId: entityId, limitVnd: value },
      at,
    );
  }
  if (typeof value !== "string" || value.trim() === "") return reject("validation_failed");
  return finish(
    store,
    userId,
    { kind: "category_name", categoryId: entityId, name: value.trim() },
    at,
  );
}

async function finish(
  store: SampleBudgetStore,
  userId: string,
  edit: PlanEdit,
  at: Date,
): Promise<BudgetEditResult> {
  return (await store.applyPlanEdit(userId, edit, at)) === "applied"
    ? { status: "applied" }
    : { status: "not_found" };
}
