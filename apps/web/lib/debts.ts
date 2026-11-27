import { DebtListResponseSchema, type Debt } from "@my-wife/contracts";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type DebtsResult =
  { status: "ready"; debts: Debt[] } | { status: "empty" } | { status: "error" };

/** A debt still counts while it is open or partly settled. */
export function isOpenDebt(debt: Pick<Debt, "state">): boolean {
  return debt.state === "open" || debt.state === "partially_settled";
}

/** What is still owed on a debt, in integer VND. */
export function remainingVnd(debt: Pick<Debt, "amountVnd" | "settledVnd">): number {
  return Math.max(0, debt.amountVnd - debt.settledVnd);
}

/** Open payables and receivables, soonest due date first and undated last. */
export function splitDebts(debts: Debt[]): { payables: Debt[]; receivables: Debt[] } {
  const open = debts.filter(isOpenDebt).sort((a, b) => {
    if (a.dueAt === b.dueAt) return 0;
    if (a.dueAt === null) return 1;
    if (b.dueAt === null) return -1;
    return a.dueAt.localeCompare(b.dueAt);
  });
  return {
    payables: open.filter((d) => d.kind === "payable"),
    receivables: open.filter((d) => d.kind === "receivable"),
  };
}

/** Reads the debt ledger through the gateway; closed debts count as empty. */
export async function loadDebts(doFetch: FetchLike = fetch): Promise<DebtsResult> {
  try {
    const res = await doFetch("/api/budget/debts", { cache: "no-store" });
    if (!res.ok) return { status: "error" };
    const parsed = DebtListResponseSchema.safeParse(await res.json());
    if (!parsed.success || !parsed.data.ok) return { status: "error" };
    const open = parsed.data.data.debts.filter(isOpenDebt);
    return open.length === 0 ? { status: "empty" } : { status: "ready", debts: open };
  } catch {
    return { status: "error" };
  }
}
