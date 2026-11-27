import { SETTINGS, type EventEnvelope, type SettingKey } from "@my-wife/contracts";
import { createDebtOpener, resolveDueAt, type DebtRecord } from "./debts";
import type { IncomePoolEntry, SampleBudgetStore } from "./onboarding";

type Settings = Partial<Record<SettingKey, unknown>>;

const nonNegInt = (raw: unknown, fallback: number) =>
  Number.isSafeInteger(raw) && (raw as number) >= 0 ? (raw as number) : fallback;

/** Days a friend has to pay a share back, from the user's settings (spec 10 section 6). */
export const groupExpenseCollectDays = (settings: Settings) =>
  nonNegInt(
    settings["debt.group_expense_collect_days"],
    SETTINGS["debt.group_expense_collect_days"].default,
  );

const isPositiveInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** Body of "Group expense": what the user paid and who owes a share (spec 10 section 6). */
export interface GroupExpenseRequest {
  totalVnd: number;
  categoryId?: string;
  /** The user's own share; when omitted it is the remainder after the friends' shares. */
  ownShareVnd?: number;
  friends: { person: string; shareVnd?: number }[];
  dueAt?: string | null;
}

/** Validates an untrusted body; null when it is not a well-formed request. */
export function parseGroupExpenseRequest(body: unknown): GroupExpenseRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (!isPositiveInt(b.totalVnd) || !Array.isArray(b.friends) || b.friends.length === 0) {
    return null;
  }
  if (b.categoryId !== undefined && !isNonEmptyString(b.categoryId)) return null;
  if (
    b.ownShareVnd !== undefined &&
    !(Number.isSafeInteger(b.ownShareVnd) && (b.ownShareVnd as number) >= 0)
  ) {
    return null;
  }
  if (
    b.dueAt !== undefined &&
    b.dueAt !== null &&
    !(typeof b.dueAt === "string" && !Number.isNaN(Date.parse(b.dueAt)))
  ) {
    return null;
  }
  const friends: GroupExpenseRequest["friends"] = [];
  for (const f of b.friends as unknown[]) {
    if (typeof f !== "object" || f === null) return null;
    const { person, shareVnd } = f as Record<string, unknown>;
    if (!isNonEmptyString(person)) return null;
    if (shareVnd !== undefined && !isPositiveInt(shareVnd)) return null;
    friends.push(shareVnd === undefined ? { person } : { person, shareVnd });
  }
  return {
    totalVnd: b.totalVnd,
    categoryId: b.categoryId as string | undefined,
    ownShareVnd: b.ownShareVnd as number | undefined,
    friends,
    dueAt: b.dueAt as string | null | undefined,
  };
}

export interface GroupSplit {
  ownShareVnd: number;
  shares: { person: string; shareVnd: number }[];
}

/**
 * Pure: splits a shared expense paid by the user. The shares and the own share always add up to
 * `totalVnd`. Friends either all carry a share or none do; with none, the rest after the own
 * share (or after an equal split by head count) is divided evenly. Leftover VND goes to the user
 * in the head-count split, and one VND each to the first friends when the own share is given.
 * Returns null for input that cannot add up.
 */
export function splitGroupExpense(
  totalVnd: number,
  friends: readonly { person: string; shareVnd?: number }[],
  ownShareVnd?: number,
): GroupSplit | null {
  if (!isPositiveInt(totalVnd) || friends.length === 0) return null;
  const explicit = friends.filter((f) => f.shareVnd !== undefined).length;
  if (explicit !== 0 && explicit !== friends.length) return null;
  if (ownShareVnd !== undefined && !(Number.isSafeInteger(ownShareVnd) && ownShareVnd >= 0)) {
    return null;
  }
  if (explicit > 0) {
    const shares = friends.map((f) => ({ person: f.person, shareVnd: f.shareVnd as number }));
    if (!shares.every((s) => isPositiveInt(s.shareVnd))) return null;
    const rest = totalVnd - shares.reduce((sum, s) => sum + s.shareVnd, 0);
    if (rest < 0 || (ownShareVnd !== undefined && ownShareVnd !== rest)) return null;
    return { ownShareVnd: rest, shares };
  }
  if (ownShareVnd === undefined) {
    const each = Math.floor(totalVnd / (friends.length + 1));
    if (each <= 0) return null;
    return {
      ownShareVnd: totalVnd - each * friends.length,
      shares: friends.map((f) => ({ person: f.person, shareVnd: each })),
    };
  }
  const rest = totalVnd - ownShareVnd;
  const each = Math.floor(rest / friends.length);
  if (each <= 0) return null;
  const extra = rest - each * friends.length;
  return {
    ownShareVnd,
    shares: friends.map((f, i) => ({ person: f.person, shareVnd: each + (i < extra ? 1 : 0) })),
  };
}

/** Pure: the income pool not yet given to a cycle (spec 10 section 6). */
export const incomePoolTotalVnd = (entries: readonly IncomePoolEntry[]) =>
  entries.filter((e) => e.allocatedCycleId === null).reduce((sum, e) => sum + e.amountVnd, 0);

export interface IncomePoolDeps {
  store: SampleBudgetStore;
  now: () => Date;
  newId: () => string;
  publish: (event: EventEnvelope) => void | Promise<void>;
  readSettings?: (userId: string) => Promise<Settings>;
}

export type GroupExpenseResult =
  | { ok: true; data: { ownShareVnd: number; debtIds: string[] } }
  | { ok: false; error: { code: "budget.invalid_group_expense" | "budget.cycle_not_found" } };

/**
 * "Group expense": the own share stays with the category, every friend's share becomes a
 * receivable funded from it, due after `debt.group_expense_collect_days`. Each receivable emits
 * `debt.opened` once. An overdue receivable follows the write-off rule of the debt ledger.
 */
export function createGroupExpenseRecorder(deps: IncomePoolDeps) {
  const opener = createDebtOpener(deps);

  async function record(userId: string, request: unknown): Promise<GroupExpenseResult> {
    const invalid = { ok: false, error: { code: "budget.invalid_group_expense" } } as const;
    const req = parseGroupExpenseRequest(request);
    if (!req) return invalid;
    const split = splitGroupExpense(req.totalVnd, req.friends, req.ownShareVnd);
    if (!split) return invalid;
    const record = await deps.store.find(userId);
    if (!record) return { ok: false, error: { code: "budget.cycle_not_found" } };
    if (req.categoryId && !record.categories.some((c) => c.id === req.categoryId)) return invalid;
    const at = deps.now();
    const settings = (await deps.readSettings?.(userId)) ?? {};
    const dueAt = resolveDueAt(at, req.dueAt ?? null, groupExpenseCollectDays(settings));
    const debts: DebtRecord[] = split.shares.map((s) => ({
      id: deps.newId(),
      kind: "receivable",
      person: s.person,
      amountVnd: s.shareVnd,
      settledVnd: 0,
      dueAt,
      state: "open",
      fundingCategoryId: req.categoryId ?? null,
      openedAt: at.toISOString(),
      openedAnnounced: false,
    }));
    if ((await deps.store.openDebts(userId, debts, at)) === "not_found") {
      return { ok: false, error: { code: "budget.cycle_not_found" } };
    }
    await opener.announceOwed(userId);
    return { ok: true, data: { ownShareVnd: split.ownShareVnd, debtIds: debts.map((d) => d.id) } };
  }

  return { record, announceOwed: opener.announceOwed };
}

export type RecordIncomeResult =
  | { ok: true; data: { entryId: string; poolTotalVnd: number } }
  | { ok: false; error: { code: "budget.invalid_income" | "budget.cycle_not_found" } };

/** Records income into the pool and emits `income.recorded` once (retried when the bus fails). */
export function createIncomeRecorder(deps: IncomePoolDeps) {
  async function announcePending(userId: string): Promise<void> {
    const record = await deps.store.find(userId);
    for (const entry of record?.incomePool ?? []) {
      if (entry.announced) continue;
      await deps.publish({
        id: `income-recorded-${entry.id}`,
        type: "income.recorded",
        occurredAt: entry.receivedAt,
        userId,
        schemaVersion: 1,
        payload: { entryId: entry.id, amountVnd: entry.amountVnd, payer: entry.payer },
      } as EventEnvelope);
      await deps.store.markIncomeAnnounced(userId, entry.id);
    }
  }

  async function record(userId: string, request: unknown): Promise<RecordIncomeResult> {
    const b = (typeof request === "object" && request !== null ? request : {}) as Record<
      string,
      unknown
    >;
    if (!isPositiveInt(b.amountVnd) || !isNonEmptyString(b.payer)) {
      return { ok: false, error: { code: "budget.invalid_income" } };
    }
    const at = deps.now();
    const entry: IncomePoolEntry = {
      id: deps.newId(),
      amountVnd: b.amountVnd,
      payer: b.payer,
      receivedAt: at.toISOString(),
      sourceTransactionId: "manual",
      allocatedCycleId: null,
      announced: false,
    };
    if ((await deps.store.recordIncome(userId, entry, at)) === "not_found") {
      return { ok: false, error: { code: "budget.cycle_not_found" } };
    }
    await announcePending(userId);
    const after = await deps.store.find(userId);
    return {
      ok: true,
      data: { entryId: entry.id, poolTotalVnd: incomePoolTotalVnd(after?.incomePool ?? []) },
    };
  }

  return { record, announcePending };
}
