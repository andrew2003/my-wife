import {
  CreateDebtRequestSchema,
  SETTINGS,
  type Debt,
  type EventEnvelope,
  type SettingKey,
} from "@my-wife/contracts";
import type { SampleBudgetRecord, SampleBudgetStore } from "./onboarding";
import type { TransactionRecord } from "./transactions";
import { getCategoryBalances } from "./transactions";
import { pickWantCategory } from "./unknown-spend";

const DAY_MS = 86_400_000;

/** A debt of the ledger (spec 10 section 6) with the bookkeeping flags of its events. */
export interface DebtRecord extends Debt {
  openedAt: string;
  /** False until `debt.opened` was published, so a failed publish is retried. */
  openedAnnounced: boolean;
  /** Set when an overdue receivable was written off: the expense transaction it produced. */
  writeOffTransactionId?: string;
  /** False until `debt.written_off` (and the `txn.recorded` of the expense) was published. */
  writtenOffAnnounced?: boolean;
}

export type CreateDebtRequest = Pick<
  Debt,
  "kind" | "person" | "amountVnd" | "dueAt" | "fundingCategoryId"
>;

type Settings = Partial<Record<SettingKey, unknown>>;

const nonNegInt = (raw: unknown, fallback: number) =>
  Number.isSafeInteger(raw) && (raw as number) >= 0 ? (raw as number) : fallback;

/** Days after the due date when the user is asked "keep waiting or write off". */
export const writeOffPromptDays = (settings: Settings) =>
  nonNegInt(
    settings["debt.receivable_write_off_prompt_days"],
    SETTINGS["debt.receivable_write_off_prompt_days"].default,
  );

/**
 * Pure: the due date of a new debt. A requested date is kept; otherwise it is `openedAt` plus
 * `defaultDays` (see docs/decisions.md, MW-061: the existing prompt-days setting is the default).
 */
export function resolveDueAt(
  openedAt: Date,
  requestedDueAt: string | null,
  defaultDays: number,
): string {
  if (requestedDueAt) return requestedDueAt;
  return new Date(openedAt.getTime() + defaultDays * DAY_MS).toISOString();
}

/** Pure: true once `now` is more than `promptDays` days after the due date (spec 10 section 12). */
export function isPastWriteOffPrompt(dueAt: string, now: Date, promptDays: number): boolean {
  return now.getTime() > Date.parse(dueAt) + promptDays * DAY_MS;
}

/** Pure: the part of a debt that is still owed. */
export const openAmountVnd = (d: Pick<Debt, "amountVnd" | "settledVnd">) =>
  Math.max(0, d.amountVnd - d.settledVnd);

export interface DebtDeps {
  store: SampleBudgetStore;
  now: () => Date;
  newId: () => string;
  publish: (event: EventEnvelope) => void | Promise<void>;
  readSettings?: (userId: string) => Promise<Settings>;
}

export type OpenDebtResult =
  | { ok: true; data: Debt }
  | { ok: false; error: { code: "budget.invalid_debt" | "budget.cycle_not_found" } };

/** Opens debts (a loan to a friend, a borrow) and announces `debt.opened` once. */
export function createDebtOpener(deps: DebtDeps) {
  async function announceOwed(userId: string): Promise<void> {
    const record = await deps.store.find(userId);
    for (const d of record?.debts ?? []) {
      if (d.openedAnnounced) continue;
      await deps.publish({
        id: `debt-opened-${d.id}`,
        type: "debt.opened",
        occurredAt: d.openedAt,
        userId,
        schemaVersion: 1,
        payload: { debtId: d.id, kind: d.kind, amountVnd: d.amountVnd, dueAt: d.dueAt },
      } as EventEnvelope);
      await deps.store.markDebtOpenedAnnounced(userId, d.id);
    }
  }

  async function open(userId: string, request: unknown): Promise<OpenDebtResult> {
    const parsed = CreateDebtRequestSchema.safeParse(request);
    if (!parsed.success || parsed.data.amountVnd <= 0) {
      return { ok: false, error: { code: "budget.invalid_debt" } };
    }
    const record = await deps.store.find(userId);
    if (!record) return { ok: false, error: { code: "budget.cycle_not_found" } };
    const req = parsed.data;
    if (req.fundingCategoryId && !record.categories.some((c) => c.id === req.fundingCategoryId)) {
      return { ok: false, error: { code: "budget.invalid_debt" } };
    }
    const at = deps.now();
    const settings = (await deps.readSettings?.(userId)) ?? {};
    const debt: DebtRecord = {
      id: deps.newId(),
      kind: req.kind,
      person: req.person,
      amountVnd: req.amountVnd,
      settledVnd: 0,
      dueAt: resolveDueAt(at, req.dueAt, writeOffPromptDays(settings)),
      state: "open",
      fundingCategoryId: req.fundingCategoryId,
      openedAt: at.toISOString(),
      openedAnnounced: false,
    };
    await deps.store.openDebt(userId, debt, at);
    await announceOwed(userId);
    return { ok: true, data: toDebt(debt) };
  }

  return { open, announceOwed };
}

export function toDebt(d: DebtRecord): Debt {
  return {
    id: d.id,
    kind: d.kind,
    person: d.person,
    amountVnd: d.amountVnd,
    settledVnd: d.settledVnd,
    dueAt: d.dueAt,
    state: d.state,
    fundingCategoryId: d.fundingCategoryId,
  };
}

/** Receivables still owing money whose write-off prompt was ignored (spec 10 section 6). */
export function receivablesToWriteOff(
  debts: readonly DebtRecord[],
  now: Date,
  promptDays: number,
): DebtRecord[] {
  return debts.filter(
    (d) =>
      d.kind === "receivable" &&
      (d.state === "open" || d.state === "partially_settled") &&
      openAmountVnd(d) > 0 &&
      d.dueAt !== null &&
      isPastWriteOffPrompt(d.dueAt, now, promptDays),
  );
}

/**
 * Books every receivable that is overdue past the prompt days as an expense of its funding
 * category (the first `want` category with room when it has none; nothing is booked when the user
 * has no `want` category). Called when a week closes, with the end of that week as the booking
 * time so the expense counts in the week being closed. Idempotent: a written-off debt is skipped.
 * Then publishes the events still owed (`txn.recorded`, `debt.written_off`); a failed publish is
 * retried by the next call.
 */
export async function writeOffOverdueReceivables(
  deps: Omit<DebtDeps, "readSettings"> & { settings: Settings },
  userId: string,
  now: Date,
  bookedAt: Date,
): Promise<void> {
  const promptDays = writeOffPromptDays(deps.settings);
  const record = await deps.store.find(userId);
  if (!record || record.cycle.state !== "running") return;
  for (const debt of receivablesToWriteOff(record.debts, now, promptDays)) {
    const fresh = (await deps.store.find(userId)) ?? record;
    const category = debt.fundingCategoryId
      ? fresh.categories.find((c) => c.id === debt.fundingCategoryId)
      : pickWantCategory(fresh.categories, getCategoryBalances(fresh), openAmountVnd(debt));
    if (!category) continue;
    const txn: TransactionRecord = {
      id: deps.newId(),
      cycleId: fresh.cycle.id,
      receiptId: `debt:${debt.id}`,
      bankTransactionRef: `debt-write-off-${debt.id}`,
      bankAccountId: category.bankAccountId,
      direction: "out",
      amountVnd: openAmountVnd(debt),
      occurredAt: bookedAt.toISOString(),
      memo: `write-off ${debt.id}`,
      counterparty: debt.person,
      transactionType: "loan_out",
      reconciliationResult: "adjusted",
      categoryId: category.id,
      announced: false,
    };
    await deps.store.writeOffDebt(userId, debt.id, txn, now);
  }
  await announceWriteOffs(deps, userId, now);
}

async function announceWriteOffs(
  deps: Omit<DebtDeps, "readSettings">,
  userId: string,
  now: Date,
): Promise<void> {
  const record: SampleBudgetRecord | undefined = await deps.store.find(userId);
  for (const d of record?.debts ?? []) {
    if (d.state !== "written_off" || d.writtenOffAnnounced !== false) continue;
    const txn = record!.transactions.find((t) => t.id === d.writeOffTransactionId);
    if (!txn) continue;
    if (!txn.announced) {
      await deps.publish({
        id: `txn-recorded-${txn.id}`,
        type: "txn.recorded",
        occurredAt: txn.occurredAt,
        userId,
        schemaVersion: 1,
        payload: {
          transactionId: txn.id,
          cycleId: txn.cycleId,
          amountVnd: txn.amountVnd,
          direction: txn.direction,
          transactionType: txn.transactionType,
          reconciliationResult: txn.reconciliationResult,
          categoryId: txn.categoryId,
          bankAccountId: txn.bankAccountId,
          memo: txn.memo,
        },
      } as EventEnvelope);
      await deps.store.markTransactionAnnounced(userId, txn.id);
    }
    await deps.publish({
      id: `debt-written-off-${d.id}`,
      type: "debt.written_off",
      occurredAt: now.toISOString(),
      userId,
      schemaVersion: 1,
      payload: { debtId: d.id, amountVnd: txn.amountVnd, bookedToCategoryId: txn.categoryId },
    } as EventEnvelope);
    await deps.store.markDebtWrittenOffAnnounced(userId, d.id);
  }
}
