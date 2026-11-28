import {
  seedDemoBudget,
  type MemorySampleBudgetStore,
  type MemoryWeeklyMenuStore,
} from "@my-wife/budget";
import type { MemoryIngestStore } from "@my-wife/ingest";
import { seedDemoWeek, type PlanStore } from "@my-wife/schedule";

/** Id of the demo receipt; the all-screens test opens `/receipts/<this id>`. */
export const DEMO_RECEIPT_ID = "0190a0a0-0000-7000-8000-00000000f001";

const DAY_MS = 86_400_000;

/** Monday (UTC) of the week that contains `at`, as `YYYY-MM-DD`. */
function mondayOf(at: Date): string {
  const day = (at.getUTCDay() + 6) % 7;
  return new Date(at.getTime() - day * DAY_MS).toISOString().slice(0, 10);
}

export interface DemoDataDeps {
  userId: string;
  now: () => Date;
  locale: "vi" | "en";
  budget: { store: MemorySampleBudgetStore; menus: MemoryWeeklyMenuStore };
  planStore: PlanStore;
  receipts: MemoryIngestStore;
}

/**
 * Gives the demo user data behind every read path the web opens, so each screen renders
 * without a 4xx: a running cycle with weekly menus, a current week and one parsed receipt.
 * Each part is idempotent.
 */
export async function seedDemoData(deps: DemoDataDeps): Promise<void> {
  const { userId } = deps;
  const at = deps.now();
  await seedDemoBudget({
    store: deps.budget.store,
    menus: deps.budget.menus,
    userId,
    now: deps.now,
    locale: deps.locale,
  });
  seedDemoWeek({
    store: deps.planStore,
    userId,
    firstDay: mondayOf(at),
    newId: () => `demo-week-${userId}`,
  });
  if (!(await deps.receipts.findById(DEMO_RECEIPT_ID))) {
    await deps.receipts.save({
      id: DEMO_RECEIPT_ID,
      userId,
      state: "parsed",
      messageId: null,
      sender: null,
      sizeBytes: 0,
      receivedAt: at.toISOString(),
      dkimResult: "pass",
      source: "parser",
      bankTransactionRef: "demo-receipt-ref",
      fields: {
        bankTransactionRef: "demo-receipt-ref",
        bankAccountHint: "0000",
        direction: "out",
        amountVnd: 50_000,
        currency: "VND",
        counterparty: null,
        memo: "demo",
        occurredAt: at.toISOString(),
      },
    });
  }
}
