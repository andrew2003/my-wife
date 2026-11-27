import { SETTINGS, type EventEnvelope, type SettingKey } from "@my-wife/contracts";
import type { SampleBudgetStore } from "./onboarding";
import type { TransactionRecord } from "./transactions";

/** A balance of one account at one moment (contracts: BalanceSnapshotSchema). */
export interface BalanceSnapshot {
  bankAccountId: string;
  balanceVnd: number;
  source: "user" | "email";
  takenAt: string;
}
type Settings = Partial<Record<SettingKey, unknown>>;

/** Allowed gap in whole VND between the ledger and the account balance (spec 10 section 9). */
export function balanceToleranceVnd(settings: Settings): number {
  const raw = settings["budget.balance_tolerance_vnd"];
  return Number.isSafeInteger(raw) && (raw as number) >= 0
    ? (raw as number)
    : SETTINGS["budget.balance_tolerance_vnd"].default;
}

export interface BalanceEvaluation {
  expectedVnd: number;
  /** actual minus expected: negative means money left that the ledger does not explain. */
  differenceVnd: number;
  exceeds: boolean;
}

export interface EvaluateBalanceInput {
  bankAccountId: string;
  previous: Pick<BalanceSnapshot, "balanceVnd" | "takenAt">;
  actual: Pick<BalanceSnapshot, "balanceVnd" | "takenAt">;
  transactions: readonly Pick<
    TransactionRecord,
    "direction" | "amountVnd" | "occurredAt" | "bankAccountId"
  >[];
  toleranceVnd: number;
}

/**
 * Pure: `expected = previous snapshot + inflows - outflows` of the account for transactions
 * after the previous snapshot up to and including the new one (spec 10 section 9). The gap
 * exceeds the tolerance only when strictly larger.
 */
export function evaluateBalance(input: EvaluateBalanceInput): BalanceEvaluation {
  const from = Date.parse(input.previous.takenAt);
  const to = Date.parse(input.actual.takenAt);
  let expectedVnd = input.previous.balanceVnd;
  for (const t of input.transactions) {
    if (t.bankAccountId !== input.bankAccountId) continue;
    const at = Date.parse(t.occurredAt);
    if (at <= from || at > to) continue;
    expectedVnd += t.direction === "in" ? t.amountVnd : -t.amountVnd;
  }
  const differenceVnd = input.actual.balanceVnd - expectedVnd;
  return { expectedVnd, differenceVnd, exceeds: Math.abs(differenceVnd) > input.toleranceVnd };
}

export interface BalanceSnapshotStore {
  /** The newest snapshot of the account, if any. */
  latest(userId: string, bankAccountId: string): Promise<BalanceSnapshot | undefined>;
  /** Appends a snapshot (append-only history). */
  add(userId: string, snapshot: BalanceSnapshot): Promise<void>;
}

export class MemoryBalanceSnapshotStore implements BalanceSnapshotStore {
  private readonly rows = new Map<string, BalanceSnapshot[]>();

  async latest(userId: string, bankAccountId: string) {
    const list = this.rows.get(`${userId}:${bankAccountId}`) ?? [];
    return list.reduce<BalanceSnapshot | undefined>(
      (best, s) => (!best || Date.parse(s.takenAt) > Date.parse(best.takenAt) ? s : best),
      undefined,
    );
  }

  async add(userId: string, snapshot: BalanceSnapshot) {
    const key = `${userId}:${snapshot.bankAccountId}`;
    this.rows.set(key, [...(this.rows.get(key) ?? []), { ...snapshot }]);
  }
}

export interface BalanceCheckDeps {
  store: SampleBudgetStore;
  snapshots: BalanceSnapshotStore;
  publish: (event: EventEnvelope) => void | Promise<void>;
  readSettings?: (userId: string) => Promise<Settings>;
}

export interface BalanceInput {
  bankAccountId: string;
  balanceVnd: number;
  takenAt: string;
  source?: BalanceSnapshot["source"];
}

/**
 * The weekly balance check (spec 10 section 9). For each submitted balance it compares the
 * ledger with the account and emits `balance.discrepancy_found` when the gap is above
 * `budget.balance_tolerance_vnd`. The first snapshot of an account is only a baseline. A
 * snapshot not newer than the stored one is ignored, so a repeat emits once. Opening the
 * `missing_receipt` anomaly and the penalty savings rule are follow-ups.
 */
export function createBalanceCheck(deps: BalanceCheckDeps) {
  async function run(userId: string, balances: readonly BalanceInput[], now: Date) {
    const record = await deps.store.find(userId);
    const settings = (await deps.readSettings?.(userId)) ?? {};
    const toleranceVnd = balanceToleranceVnd(settings);
    let discrepancies = 0;
    for (const b of balances) {
      if (!record?.accounts.some((a) => a.id === b.bankAccountId)) continue;
      if (!Number.isSafeInteger(b.balanceVnd) || Number.isNaN(Date.parse(b.takenAt))) continue;
      const previous = await deps.snapshots.latest(userId, b.bankAccountId);
      if (previous && Date.parse(b.takenAt) <= Date.parse(previous.takenAt)) continue;
      await deps.snapshots.add(userId, {
        bankAccountId: b.bankAccountId,
        balanceVnd: b.balanceVnd,
        source: b.source ?? "user",
        takenAt: b.takenAt,
      });
      if (!previous) continue;
      const result = evaluateBalance({
        bankAccountId: b.bankAccountId,
        previous,
        actual: b,
        transactions: record.transactions,
        toleranceVnd,
      });
      if (!result.exceeds) continue;
      discrepancies += 1;
      await deps.publish({
        id: `balance-discrepancy-${b.bankAccountId}-${b.takenAt}`,
        type: "balance.discrepancy_found",
        occurredAt: now.toISOString(),
        userId,
        schemaVersion: 1,
        payload: {
          bankAccountId: b.bankAccountId,
          expectedVnd: result.expectedVnd,
          actualVnd: b.balanceVnd,
          differenceVnd: result.differenceVnd,
        },
      } as EventEnvelope);
    }
    return { checked: balances.length, discrepancies };
  }
  return { run };
}
