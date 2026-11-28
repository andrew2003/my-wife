import { randomUUID } from "node:crypto";
import type { EventEnvelope, SettingKey } from "@my-wife/contracts";
import { buildFundRequests } from "./approval";
import { createOnboardingHandler, type SampleBudgetStore } from "./onboarding";
import { createWeeklyMenuService, type MenuDish, type WeeklyMenuStore } from "./weekly-menu";

export interface DemoSeedDeps {
  store: SampleBudgetStore;
  userId: string;
  /** Time is a parameter so the seed can be simulated. */
  now: () => Date;
  locale: "vi" | "en";
  /** Receives the events the seed would publish; the demo passes a no-op. */
  publish?: (event: EventEnvelope) => void | Promise<void>;
  /** When given, every week of the new cycle also gets a proposed menu. */
  menus?: WeeklyMenuStore;
  readSettings?: (userId: string) => Promise<Partial<Record<SettingKey, unknown>>>;
}

/** Demo data, not interface text: dish names are stored content in the user's language. */
const DEMO_DISHES: Record<"vi" | "en", MenuDish[]> = {
  vi: [
    {
      name: "Cơm gà",
      ingredients: [
        { name: "Gạo", unit: "kg", quantity: 1, unitPriceVnd: 20_000 },
        { name: "Thịt gà", unit: "kg", quantity: 1, unitPriceVnd: 70_000 },
      ],
    },
    {
      name: "Canh rau",
      ingredients: [{ name: "Rau cải", unit: "kg", quantity: 1, unitPriceVnd: 25_000 }],
    },
  ],
  en: [
    {
      name: "Chicken rice",
      ingredients: [
        { name: "Rice", unit: "kg", quantity: 1, unitPriceVnd: 20_000 },
        { name: "Chicken", unit: "kg", quantity: 1, unitPriceVnd: 70_000 },
      ],
    },
    {
      name: "Vegetable soup",
      ingredients: [{ name: "Greens", unit: "kg", quantity: 1, unitPriceVnd: 25_000 }],
    },
  ],
};

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

  if (deps.menus) {
    const menus = createWeeklyMenuService({
      store,
      menus: deps.menus,
      now: deps.now,
      readSettings: deps.readSettings,
    });
    for (let weekIndex = 1; weekIndex <= cycle.weeks; weekIndex += 1) {
      await menus.generate(userId, { weekIndex, dishes: DEMO_DISHES[deps.locale] });
    }
  }
  return "seeded";
}
