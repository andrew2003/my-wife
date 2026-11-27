import { describe, expect, it } from "vitest";
import type { EventEnvelope, PlannedItem, SettingKey } from "@my-wife/contracts";
import { createOnboardingHandler, MemorySampleBudgetStore } from "../src/onboarding";
import { createTransactionHandler } from "../src/transactions";

const NOW = new Date("2026-03-05T10:00:00Z");
const CODE = "MW-C01W1-AN-01";

function receipt(o: { ref: string; memo?: string; amount: number; hint: string }): EventEnvelope {
  return {
    id: `ev-${o.ref}`,
    type: "receipt.parsed",
    occurredAt: NOW.toISOString(),
    userId: "u1",
    schemaVersion: 1,
    payload: {
      receiptId: `r-${o.ref}`,
      bankTransactionRef: o.ref,
      bankAccountHint: o.hint,
      direction: "out",
      amountVnd: o.amount,
      currency: "VND",
      counterparty: null,
      memo: o.memo ?? CODE,
      occurredAt: NOW.toISOString(),
      source: "email",
      fxProvisional: false,
    },
  } as unknown as EventEnvelope;
}

async function seeded(settings: Partial<Record<SettingKey, unknown>> = {}, planned = 1_000_000) {
  const store = new MemorySampleBudgetStore();
  let n = 0;
  await createOnboardingHandler({
    store,
    locale: "en",
    now: () => NOW,
    newId: () => `id-${++n}`,
    publish: () => undefined,
  })({
    id: "e0",
    type: "onboarding.step_completed",
    occurredAt: NOW.toISOString(),
    userId: "u1",
    schemaVersion: 1,
    payload: { step: "qa_templates", skipped: true },
  } as EventEnvelope);
  const record = store.get("u1")!;
  record.cycle.state = "running";
  const category = record.categories.find((c) => c.shortCode === "AN")!;
  const item: PlannedItem = {
    id: "pi-1",
    categoryId: category.id,
    number: 1,
    amountVnd: planned,
    transferCode: CODE,
    status: "planned",
  };
  record.plannedItems.push(item);
  const account = record.accounts.find((a) => a.id === category.bankAccountId)!;
  const other = record.accounts.find((a) => a.id !== category.bankAccountId);
  const published: EventEnvelope[] = [];
  const handle = createTransactionHandler({
    store,
    now: () => NOW,
    newId: () => `id-${++n}`,
    publish: (e) => void published.push(e),
    readSettings: async () => settings,
  });
  return { store, record, handle, published, account, other };
}

describe("planned transfer reconciliation (#304)", () => {
  it("reconciles a receipt within the default tolerance (5 percent)", async () => {
    const s = await seeded();
    await s.handle(receipt({ ref: "a", amount: 1_050_000, hint: s.account.code }));
    const txn = s.store.get("u1")!.transactions[0]!;
    expect(txn).toMatchObject({
      transactionType: "planned_transfer",
      reconciliationResult: "matched",
      plannedItemId: "pi-1",
    });
    expect(s.store.get("u1")!.plannedItems[0]!.status).toBe("matched");
    const ev = s.published.find((e) => e.type === "txn.recorded") as EventEnvelope<"txn.recorded">;
    expect(ev.payload.reconciliationResult).toBe("matched");
    expect(ev.payload.transactionType).toBe("planned_transfer");
  });

  it("does not reconcile outside the tolerance", async () => {
    const s = await seeded();
    await s.handle(receipt({ ref: "a", amount: 1_050_001, hint: s.account.code }));
    expect(s.store.get("u1")!.transactions[0]!.reconciliationResult).toBe("amount_mismatch");
    expect(s.store.get("u1")!.plannedItems[0]!.status).toBe("mismatch");
  });

  it("uses the minimum tolerance for a small planned amount", async () => {
    const s = await seeded({}, 100_000);
    await s.handle(receipt({ ref: "a", amount: 110_000, hint: s.account.code }));
    expect(s.store.get("u1")!.transactions[0]!.reconciliationResult).toBe("matched");
  });

  it("takes tolerance from the user settings", async () => {
    const s = await seeded({ "budget.tolerance_percent": 1, "budget.tolerance_min_vnd": 0 });
    await s.handle(receipt({ ref: "a", amount: 1_050_000, hint: s.account.code }));
    expect(s.store.get("u1")!.transactions[0]!.reconciliationResult).toBe("amount_mismatch");
  });

  it("falls back to defaults for an invalid setting value", async () => {
    const s = await seeded({ "budget.tolerance_percent": "lots" });
    await s.handle(receipt({ ref: "a", amount: 1_050_000, hint: s.account.code }));
    expect(s.store.get("u1")!.transactions[0]!.reconciliationResult).toBe("matched");
  });

  it("reports wrong_bank when paid from another account", async () => {
    const s = await seeded();
    expect(s.other).toBeDefined();
    await s.handle(receipt({ ref: "a", amount: 1_000_000, hint: s.other!.code }));
    expect(s.store.get("u1")!.transactions[0]!.reconciliationResult).toBe("wrong_bank");
    expect(s.store.get("u1")!.plannedItems[0]!.status).toBe("mismatch");
  });

  it("does not match an already matched item a second time", async () => {
    const s = await seeded();
    await s.handle(receipt({ ref: "a", amount: 1_000_000, hint: s.account.code }));
    await s.handle(receipt({ ref: "b", amount: 1_000_000, hint: s.account.code }));
    expect(s.store.get("u1")!.transactions).toHaveLength(1);
  });

  it("is idempotent for the same receipt", async () => {
    const s = await seeded();
    const ev = receipt({ ref: "a", amount: 1_000_000, hint: s.account.code });
    await s.handle(ev);
    await s.handle(ev);
    expect(s.store.get("u1")!.transactions).toHaveLength(1);
    expect(s.published.filter((e) => e.type === "txn.recorded")).toHaveLength(1);
  });
});
