import {
  BudgetOverviewResponseSchema,
  GetSettingsResponseSchema,
  ListPenaltiesResponseSchema,
  SETTINGS,
  type AnomalyView,
  type BudgetOverviewResponse,
  type PenaltyLedgerEntry,
} from "@my-wife/contracts";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type Anomaly = AnomalyView;
export type Overview = Extract<BudgetOverviewResponse, { ok: true }>["data"];

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
    const parsed = BudgetOverviewResponseSchema.safeParse(await res.json());
    if (!parsed.success || !parsed.data.ok) return { status: "error" };
    if (!SHOWN_STATES.has(parsed.data.data.cycle.state)) return { status: "empty" };
    return { status: "ready", overview: parsed.data.data };
  } catch {
    return { status: "error" };
  }
}

export type PenaltiesResult =
  { status: "loading" } | { status: "ready"; due: PenaltyLedgerEntry[] } | { status: "error" };

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

/** Reads `calendar.time_zone`; falls back to the registry default when unreadable or invalid. */
export async function loadTimeZone(doFetch: FetchLike = fetch): Promise<string> {
  const fallback = SETTINGS["calendar.time_zone"].default;
  try {
    const res = await doFetch("/api/settings", { cache: "no-store" });
    if (!res.ok) return fallback;
    const parsed = GetSettingsResponseSchema.safeParse(await res.json());
    if (!parsed.success || !parsed.data.ok) return fallback;
    const zone = parsed.data.data.values["calendar.time_zone"];
    if (typeof zone !== "string") return fallback;
    try {
      new Intl.DateTimeFormat("en", { timeZone: zone });
      return zone;
    } catch {
      return fallback;
    }
  } catch {
    return fallback;
  }
}
