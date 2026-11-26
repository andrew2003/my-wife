import type { EventEnvelope } from "@my-wife/contracts";
import { buildFundRequests } from "./approval";
import type { SampleBudgetRecord, SampleBudgetStore } from "./onboarding";
import { matchTransferCode } from "./transfer-codes";

export interface FundingReceipt {
  direction: "in" | "out";
  amountVnd: number;
  memo: string;
}

/**
 * Pure: the transfer request a receipt funds, or undefined. It must be incoming, its memo must
 * normalize to the funding code of the request and its amount must be at least `requiredVnd`.
 */
export function matchFunding(
  receipt: FundingReceipt,
  transfers: readonly { bankAccountId: string; requiredVnd: number; memo: string }[],
) {
  if (receipt.direction !== "in") return undefined;
  const code = matchTransferCode(
    receipt.memo,
    transfers.map((t) => t.memo),
  );
  const transfer = transfers.find((t) => t.memo === code);
  if (!transfer || receipt.amountVnd < transfer.requiredVnd) return undefined;
  return transfer;
}

export interface FundingDeps {
  store: SampleBudgetStore;
  now: () => Date;
  publish: (event: EventEnvelope) => void | Promise<void>;
}

/**
 * Handles `receipt.parsed` for an `awaiting_funds` cycle (spec 10 section 3). A receipt that
 * matches a fund request counts the account as funded; when every account is funded the cycle
 * becomes `running` atomically and `cycle.opened` is published with a deterministic id. A
 * failed publish is retried on the next delivery, never by opening the cycle twice.
 */
export function createFundingHandler(deps: FundingDeps) {
  const announce = async (record: SampleBudgetRecord) => {
    const { cycle } = record;
    await deps.publish({
      id: `opened-${cycle.id}`,
      type: "cycle.opened",
      occurredAt: cycle.openedAt ?? deps.now().toISOString(),
      userId: record.userId,
      schemaVersion: 1,
      payload: { cycleId: cycle.id, sequence: cycle.sequence, firstDay: cycle.firstDay },
    } as EventEnvelope);
    await deps.store.markOpenedAnnounced(record.userId);
  };

  return async function onFundingReceipt(event: EventEnvelope): Promise<void> {
    if (event.type !== "receipt.parsed") return;
    const { payload } = event as EventEnvelope<"receipt.parsed">;
    let record = await deps.store.find(event.userId);
    if (!record) return;

    if (record.cycle.state === "running" && record.cycle.openedAt && !record.openedAnnounced) {
      await announce(record);
      return;
    }
    if (record.cycle.state !== "awaiting_funds") return;

    const transfers = buildFundRequests({
      sequence: record.cycle.sequence,
      accounts: record.accounts,
      categories: record.categories,
    });
    const match = matchFunding(payload, transfers);
    if (!match) return;

    const at = deps.now();
    await deps.store.recordFunding(
      event.userId,
      record.cycle.id,
      {
        bankAccountId: match.bankAccountId,
        bankTransactionRef: payload.bankTransactionRef,
        receiptId: payload.receiptId,
        amountVnd: payload.amountVnd,
      },
      at,
    );
    const result = await deps.store.openIfFunded(event.userId, record.cycle.id, transfers, at);
    if (result !== "opened") return;
    record = await deps.store.find(event.userId);
    if (record) await announce(record);
  };
}
