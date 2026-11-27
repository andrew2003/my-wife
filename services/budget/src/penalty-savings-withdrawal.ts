import type { EventEnvelope } from "@my-wife/contracts";
import type { SampleBudgetStore } from "./onboarding";

export interface PenaltySavingsWithdrawalDeps {
  store: SampleBudgetStore;
  publish: (event: EventEnvelope) => void | Promise<void>;
}

/**
 * Handles `receipt.parsed` (spec 10 section 9, spec 12 section 4): any outflow from the penalty
 * savings account is a withdrawal, because the account only receives penalty payments. It
 * publishes `penalty_savings.withdrawal_detected` (detected by receipt) for `rules`, which
 * decides the penalty; `budget` only reports the fact. It runs after the booking rules so the
 * booked transaction, if any, can be linked. The event id derives from the bank transaction
 * reference, so a redelivered receipt is announced once. The account resolves from the hint
 * (account code, case-insensitive), like every other receipt rule.
 */
export function createPenaltySavingsWithdrawalHandler(deps: PenaltySavingsWithdrawalDeps) {
  return async function onPenaltySavingsReceipt(event: EventEnvelope): Promise<void> {
    if (event.type !== "receipt.parsed") return;
    const { payload } = event as EventEnvelope<"receipt.parsed">;
    if (payload.direction !== "out" || payload.amountVnd <= 0) return;
    const record = await deps.store.find(event.userId);
    const hint = payload.bankAccountHint.trim().toUpperCase();
    const account = record?.accounts.find((a) => a.code.toUpperCase() === hint);
    if (!record || !account || account.kind !== "penalty_savings") return;
    const booked = record.transactions.find(
      (t) => t.bankTransactionRef === payload.bankTransactionRef,
    );
    await deps.publish({
      id: `penalty-withdrawal-${account.id}-${payload.bankTransactionRef}`,
      type: "penalty_savings.withdrawal_detected",
      occurredAt: payload.occurredAt,
      userId: event.userId,
      schemaVersion: 1,
      payload: {
        bankAccountId: account.id,
        amountVnd: payload.amountVnd,
        transactionId: booked?.id ?? null,
        detectedBy: "receipt",
      },
    } as EventEnvelope);
  };
}
