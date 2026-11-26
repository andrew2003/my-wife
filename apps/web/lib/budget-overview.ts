import {
  AnomalyKindSchema,
  BankAccountSchema,
  BudgetCategorySchema,
  BudgetCycleSchema,
  ListPenaltiesResponseSchema,
  NonNegativeVndSchema,
  TransactionSchema,
  VndAmountSchema,
  IdSchema,
  type PenaltyLedgerEntry,
} from "@my-wife/contracts";
import { z } from "zod";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** One category with its limit of the current week; the shape follows `BudgetStatusResponse`. */
export const CategoryStatusSchema = z.object({
  category: BudgetCategorySchema,
  weeklyLimitVnd: NonNegativeVndSchema,
  spentVnd: VndAmountSchema,
  remainingVnd: VndAmountSchema,
});

/** An open item of the anomaly inbox (`anomaly.opened` carries the same id, kind and subject). */
export const AnomalySchema = z.object({
  id: IdSchema,
  kind: AnomalyKindSchema,
  subjectRef: z.string().min(1),
});
export type Anomaly = z.infer<typeof AnomalySchema>;

export const OverviewSchema = z.object({
  cycle: BudgetCycleSchema,
  weekIndex: z.number().int().positive(),
  bankAccounts: z.array(BankAccountSchema),
  categories: z.array(CategoryStatusSchema),
  transactions: z.array(TransactionSchema),
  anomalies: z.array(AnomalySchema),
});
export type Overview = z.infer<typeof OverviewSchema>;

const OverviewResponseSchema = z.object({ ok: z.literal(true), data: OverviewSchema });

export type OverviewResult =
  { status: "ready"; overview: Overview } | { status: "empty" } | { status: "error" };

/** Cycle states that have spending to show. */
const SHOWN_STATES = new Set(["running", "closing"]);

/** Reads the budget overview of the current cycle through the gateway. */
export async function loadOverview(doFetch: FetchLike = fetch): Promise<OverviewResult> {
  try {
    const res = await doFetch("/api/budget/overview", { cache: "no-store" });
    if (res.status === 404) return { status: "empty" };
    if (!res.ok) return { status: "error" };
    const parsed = OverviewResponseSchema.safeParse(await res.json());
    if (!parsed.success) return { status: "error" };
    if (!SHOWN_STATES.has(parsed.data.data.cycle.state)) return { status: "empty" };
    return { status: "ready", overview: parsed.data.data };
  } catch {
    return { status: "error" };
  }
}

export type PenaltiesResult =
  | { status: "loading" }
  | { status: "ready"; due: PenaltyLedgerEntry[] }
  | { status: "error" };

/** Reads the penalty ledger and keeps the entries that are due. */
export async function loadPenalties(doFetch: FetchLike = fetch): Promise<PenaltiesResult> {
  try {
    const res = await doFetch("/api/penalties", { cache: "no-store" });
    if (!res.ok) return { status: "error" };
    const parsed = ListPenaltiesResponseSchema.safeParse(await res.json());
    if (!parsed.success || !parsed.data.ok) return { status: "error" };
    return { status: "ready", due: parsed.data.data.penalties.filter((p) => p.status === "due") };
  } catch {
    return { status: "error" };
  }
}
