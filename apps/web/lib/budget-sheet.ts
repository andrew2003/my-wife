import { CellRejectReasonSchema } from "@my-wife/contracts";
import { z } from "zod";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** The five tabs of the budget sheet, in display order. */
export const BUDGET_SHEET_TABS = [
  "categories",
  "accounts",
  "weeklyPlan",
  "ledger",
  "surplus",
] as const;
export type BudgetSheetTab = (typeof BUDGET_SHEET_TABS)[number];

// The sheet read has no contract schema yet, so this local shape mirrors `buildBudgetSheet`
// in the budget service. Which cells are editable is decided there; the screen only follows it.
const CellSchema = z.object({
  field: z.string(),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  editable: z.boolean(),
});
const RowSchema = z.object({ entityId: z.string(), cells: z.array(CellSchema) });
const SheetSchema = z.object({
  cycle: z.object({ id: z.string(), state: z.string(), firstDay: z.string() }),
  readOnly: z.boolean(),
  tabs: z.object({
    categories: z.array(RowSchema).optional(),
    accounts: z.array(RowSchema).optional(),
    weeklyPlan: z.array(RowSchema).optional(),
    ledger: z.array(RowSchema).optional(),
    surplus: z.array(RowSchema).optional(),
  }),
});
export type BudgetSheet = z.infer<typeof SheetSchema>;
export type BudgetSheetRow = z.infer<typeof RowSchema>;
export type BudgetSheetCell = z.infer<typeof CellSchema>;

const SheetEnvelope = z.object({ ok: z.literal(true), data: SheetSchema });
const EditEnvelope = z.object({
  ok: z.literal(true),
  data: z.object({
    status: z.enum(["applied", "rejected"]),
    reason: CellRejectReasonSchema.optional(),
  }),
});

export type BudgetSheetResult =
  { status: "ready"; sheet: BudgetSheet } | { status: "empty" } | { status: "error" };

export type SaveResult = { ok: true } | { ok: false; errorKey: string };

/** Reads one tab of the budget sheet of the current cycle. */
export async function loadBudgetSheet(
  tab: BudgetSheetTab,
  doFetch: FetchLike = fetch,
): Promise<BudgetSheetResult> {
  try {
    const res = await doFetch(`/api/budget/sheet?tab=${encodeURIComponent(tab)}`, {
      cache: "no-store",
    });
    if (res.status === 404) return { status: "empty" };
    if (!res.ok) return { status: "error" };
    const parsed = SheetEnvelope.safeParse(await res.json());
    return parsed.success ? { status: "ready", sheet: parsed.data.data } : { status: "error" };
  } catch {
    return { status: "error" };
  }
}

/** Money cells hold whole VND; the other plan cells hold text. */
export const isVndField = (field: string): boolean => field.endsWith("Vnd");

/** Turns the typed text into the value type of the field (NaN when it is not a number). */
export function cellValue(field: string, text: string): string | number {
  return isVndField(field) ? (text.trim() === "" ? NaN : Number(text)) : text;
}

/** Writes one plan cell; the service validates it and may reject it. */
export async function saveBudgetCell(
  tab: BudgetSheetTab,
  entityId: string,
  field: string,
  value: string | number,
  doFetch: FetchLike = fetch,
): Promise<SaveResult> {
  const failed: SaveResult = { ok: false, errorKey: "budgetsheet.error.save" };
  try {
    const res = await doFetch("/api/budget/sheet/cells", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // NaN serialises to null, which the service rejects as invalid.
      body: JSON.stringify({ sheet: "budget", tab, cellRef: field, entityId, field, value }),
    });
    if (!res.ok) return failed;
    const parsed = EditEnvelope.safeParse(await res.json());
    if (!parsed.success) return failed;
    if (parsed.data.data.status === "applied") return { ok: true };
    return {
      ok: false,
      errorKey: `budgetsheet.reject.${parsed.data.data.reason ?? "validation_failed"}`,
    };
  } catch {
    return failed;
  }
}
