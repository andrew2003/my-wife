import type { BankAccount, EventEnvelope } from "@my-wife/contracts";
import type { SampleBudgetStore } from "./onboarding";

export interface AccountState {
  accountId: string;
  code: string;
  kind: BankAccount["kind"];
  /** `unconfirmed` until a test receipt resolved to the account; the cycle guard reads this. */
  state: "confirmed" | "unconfirmed";
}

/** Reads the confirmation state of every account of the user (empty when none exist). */
export async function getAccountStates(
  store: SampleBudgetStore,
  userId: string,
): Promise<AccountState[]> {
  const record = await store.find(userId);
  return (record?.accounts ?? []).map((a) => ({
    accountId: a.id,
    code: a.code,
    kind: a.kind,
    state: a.emailNotificationsConfirmed ? "confirmed" : "unconfirmed",
  }));
}

/**
 * Handles `receipt.parsed`: the first receipt whose `bankAccountHint` resolves to an account
 * confirms that account's email notifications. The hint resolves when it equals the account
 * code, case-insensitively (decisions.md). Repeats and unresolved hints change nothing.
 */
export function createReceiptHandler(deps: { store: SampleBudgetStore; now: () => Date }) {
  return async function onReceiptParsed(event: EventEnvelope): Promise<void> {
    if (event.type !== "receipt.parsed") return;
    const { bankAccountHint, receiptId } = (event as EventEnvelope<"receipt.parsed">).payload;
    const record = await deps.store.find(event.userId);
    const hint = bankAccountHint.trim().toUpperCase();
    const account = record?.accounts.find((a) => a.code.toUpperCase() === hint);
    if (!account) return;
    await deps.store.confirmAccountEmail(event.userId, account.id, deps.now(), receiptId);
  };
}
