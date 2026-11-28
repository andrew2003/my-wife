import { randomUUID } from "node:crypto";
import type { EventEnvelope, SettingKey } from "@my-wife/contracts";
import { buildFundRequests } from "./approval";
import { createOnboardingHandler, type SampleBudgetStore } from "./onboarding";

export interface DemoSeedDeps {
  store: SampleBudgetStore;
  userId: string;
  /** Time is a parameter so the seed can be simulated. */
  now: () => Date;
  locale: "vi" | "en";
  /** Receives the events the seed would publish; the demo passes a no-op. */
  publish?: (event: EventEnvelope) => void | Promise<void>;
  readSettings?: (userId: string) => Promise<Partial<Record<SettingKey, unknown>>>;
}

/**
 * Gives the demo user a running cycle through the same store operations a real user goes
 * through (draft, approval, funding receipts, opening), so every step keeps its audit record.
 * Idempotent: a user that already has a cycle is left as it is.
 */
export async function seedDemoBudget(deps: DemoSeedDeps): Promise<"seeded" | "exists"> {
  const { store, userId } = deps;
  if (await store.find(userId)) return "exists";
  const publish = deps.publish ?? (() => undefined);
  const at = deps.now();

  await createOnboardingHandler({
    store,
    locale: deps.locale,
    now: deps.now,
    newId: randomUUID,
    publish,
    readSettings: deps.readSettings,
  })({
    id: `demo-seed-${userId}`,
    type: "onboarding.step_completed",
    occurredAt: at.toISOString(),
    userId,
    schemaVersion: 1,
    payload: { step: "qa_templates", skipped: true },
  } as EventEnvelope);

  const draft = await store.find(userId);
  if (!draft) return "exists";
  const { cycle } = draft;
  const commitmentId = `demo-commitment-${cycle.id}`;
  if ((await store.approveDraft(userId, cycle.id, commitmentId, at)) !== "ok") return "exists";
  await store.markFundsAnnounced(userId);

  const transfers = buildFundRequests({
    sequence: cycle.sequence,
    accounts: draft.accounts,
    categories: draft.categories,
  });
  for (const t of transfers.filter((r) => r.requiredVnd > 0)) {
    await store.recordFunding(
      userId,
      cycle.id,
      {
        bankAccountId: t.bankAccountId,
        bankTransactionRef: `demo-funding-${cycle.id}-${t.bankAccountId}`,
        receiptId: `demo-receipt-${t.bankAccountId}`,
        amountVnd: t.requiredVnd,
      },
      at,
    );
  }
  await store.openIfFunded(userId, cycle.id, transfers, at);
  await store.markOpenedAnnounced(userId);
  return "seeded";
}
