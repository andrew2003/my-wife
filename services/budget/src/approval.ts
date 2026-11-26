import type { BankAccount, BudgetCategory, BudgetCycle, EventEnvelope } from "@my-wife/contracts";
import type { SampleBudgetStore } from "./onboarding";
import { issueFundingCode } from "./transfer-codes";

export type ApproveErrorCode =
  | "budget.cycle_not_found"
  | "budget.cycle_not_draft"
  | "budget.contract_not_signed"
  | "budget.account_unconfirmed";

export interface TransferRequest {
  bankAccountId: string;
  requiredVnd: number;
  memo: string;
}

export type ApproveResult =
  | { ok: true; data: { cycle: BudgetCycle; transfers: TransferRequest[] } }
  | { ok: false; error: { code: ApproveErrorCode; details?: Record<string, unknown> } };

/**
 * Pure: one transfer per bank account that holds categories. The required amount is the sum of
 * the account's category cycle limits (integer VND); the memo is the funding code budget issues.
 */
export function buildFundRequests(input: {
  sequence: number;
  accounts: readonly BankAccount[];
  categories: readonly Pick<BudgetCategory, "bankAccountId" | "cycleLimitVnd">[];
}): TransferRequest[] {
  const transfers: TransferRequest[] = [];
  for (const account of input.accounts) {
    const held = input.categories.filter((c) => c.bankAccountId === account.id);
    if (held.length === 0) continue;
    transfers.push({
      bankAccountId: account.id,
      requiredVnd: held.reduce((sum, c) => sum + c.cycleLimitVnd, 0),
      memo: issueFundingCode({ cycleSequence: input.sequence, accountCode: account.code }),
    });
  }
  return transfers;
}

/** Handles `contract.signed` from rules: remembers it so approval can check the guard. */
export function createContractSignedHandler(deps: { store: SampleBudgetStore }) {
  return async function onContractSigned(event: EventEnvelope): Promise<void> {
    if (event.type !== "contract.signed") return;
    const { contractId, cycleId } = (event as EventEnvelope<"contract.signed">).payload;
    await deps.store.recordSignedContract(event.userId, contractId, cycleId);
  };
}

export interface ApproverDeps {
  store: SampleBudgetStore;
  now: () => Date;
  publish: (event: EventEnvelope) => void | Promise<void>;
}

const fail = (code: ApproveErrorCode, details?: Record<string, unknown>): ApproveResult => ({
  ok: false,
  error: details ? { code, details } : { code },
});

/**
 * Approves a draft cycle (spec 10 section 3): guards, then `draft` to `awaiting_funds`, then
 * `cycle.funds_requested`. A failed publish leaves `awaiting_funds`; calling again with the same
 * commitment re-emits it once (the event id is deterministic so consumers can deduplicate).
 */
export function createCycleApprover(deps: ApproverDeps) {
  return async function approveCycle(input: {
    userId: string;
    cycleId: string;
    commitmentId: string;
  }): Promise<ApproveResult> {
    const record = await deps.store.find(input.userId);
    if (!record || record.cycle.id !== input.cycleId) return fail("budget.cycle_not_found");
    const retry =
      record.cycle.state === "awaiting_funds" &&
      !record.fundsAnnounced &&
      record.cycle.commitmentId === input.commitmentId;
    if (record.cycle.state !== "draft" && !retry) return fail("budget.cycle_not_draft");

    if (!retry) {
      const signed = record.signedContracts.some(
        (c) => c.contractId === input.commitmentId && c.cycleId === input.cycleId,
      );
      if (!signed) return fail("budget.contract_not_signed");

      const holding = new Set(record.categories.map((c) => c.bankAccountId));
      const unconfirmed = record.accounts
        .filter((a) => holding.has(a.id) && !a.emailNotificationsConfirmed)
        .map((a) => a.id);
      if (unconfirmed.length > 0) {
        return fail("budget.account_unconfirmed", { accountIds: unconfirmed });
      }

      const moved = await deps.store.approveDraft(
        input.userId,
        input.cycleId,
        input.commitmentId,
        deps.now(),
      );
      if (moved !== "ok") {
        return fail(moved === "not_found" ? "budget.cycle_not_found" : "budget.cycle_not_draft");
      }
    }

    const transfers = buildFundRequests({
      sequence: record.cycle.sequence,
      accounts: record.accounts,
      categories: record.categories,
    });
    await deps.publish({
      id: `funds-requested-${input.cycleId}`,
      type: "cycle.funds_requested",
      occurredAt: deps.now().toISOString(),
      userId: input.userId,
      schemaVersion: 1,
      payload: { cycleId: input.cycleId, transfers },
    } as EventEnvelope);
    await deps.store.markFundsAnnounced(input.userId);
    return { ok: true, data: { cycle: { ...record.cycle }, transfers } };
  };
}
