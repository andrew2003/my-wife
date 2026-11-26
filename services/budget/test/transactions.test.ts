import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "@my-wife/contracts";
import { createOnboardingHandler, MemorySampleBudgetStore } from "../src/onboarding";
import {
  classifyCodedTransfer,
  createTransactionHandler,
  getCategoryBalances,
} from "../src/transactions";

const NOW = new Date("2026-03-05T10:00:00Z");
const LATER = new Date("2026-03-06T10:00:00Z");

function receipt(o: {
  memo: string;
  ref: string;
  amount?: number;
  direction?: "in" | "out";
  hint?: string;
  userId?: string;
}): EventEnvelope {
  return {
    id: `ev-${o.ref}`,
    type: "receipt.parsed",
    occurredAt: NOW.toISOString(),
    userId: o.userId ?? "u1",
    schemaVersion: 1,
    payload: {
      receiptId: `r-${o.ref}`,
      bankTransactionRef: o.ref,
      bankAccountHint: o.hint ?? "MAIN",
      direction: o.direction ?? "out",
      amountVnd: o.amount ?? 50_000,
      currency: "VND",
      counterparty: null,
      memo: o.memo,
      occurredAt: NOW.toISOString(),
      source: "email",
      fxProvisional: false,
    },
  } as unknown as EventEnvelope;
}

async function seeded(state: "running" | "draft" | "awaiting_funds" = "running") {
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
  record.cycle.state = state;
  const published: EventEnvelope[] = [];
  const fail = { publish: false };
  const handle = createTransactionHandler({
    store,
    now: () => LATER,
    newId: () => `id-${++n}`,
    publish: (e) => {
      if (fail.publish) throw new Error("bus down");
      published.push(e);
    },
  });
  const category = record.categories.find((c) => c.shortCode === "AN")!;
  return { store, record, handle, published, fail, category };
}

const recorded = (p: EventEnvelope[]) => p.filter((e) => e.type === "txn.recorded");
const balanceOf = (s: Awaited<ReturnType<typeof seeded>>) =>
  getCategoryBalances(s.store.get("u1")!).find((b) => b.categoryId === s.category.id)!;

describe("record a coded transfer (criterion 1)", () => {
  it("emits txn.recorded and drops the category balance by the amount", async () => {
    const s = await seeded();
    expect(balanceOf(s).balanceVnd).toBe(s.category.cycleLimitVnd);

    await s.handle(receipt({ memo: "an", ref: "t1", amount: 120_000 }));

    expect(balanceOf(s).spentVnd).toBe(120_000);
    expect(balanceOf(s).balanceVnd).toBe(s.category.cycleLimitVnd - 120_000);
    const events = recorded(s.published) as EventEnvelope<"txn.recorded">[];
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      cycleId: s.record.cycle.id,
      amountVnd: 120_000,
      direction: "out",
      transactionType: "coded_unplanned",
      reconciliationResult: "unplanned",
      categoryId: s.category.id,
      bankAccountId: s.category.bankAccountId,
      memo: "an",
    });
    expect(s.store.get("u1")!.audit.some((a) => a.action === "transaction_recorded")).toBe(true);
  });

  it("sums several transfers into the same category", async () => {
    const s = await seeded();
    await s.handle(receipt({ memo: "AN", ref: "a", amount: 10_000 }));
    await s.handle(receipt({ memo: "AN", ref: "b", amount: 25_000 }));
    expect(balanceOf(s).spentVnd).toBe(35_000);
  });

  it.each(["draft", "awaiting_funds"] as const)(
    "records nothing when the cycle is %s",
    async (state) => {
      const s = await seeded(state);
      await s.handle(receipt({ memo: "AN", ref: "t1" }));
      expect(s.store.get("u1")!.transactions).toHaveLength(0);
      expect(recorded(s.published)).toHaveLength(0);
    },
  );

  it("records nothing for a user without a budget", async () => {
    const s = await seeded();
    await s.handle(receipt({ memo: "AN", ref: "t1", userId: "u2" }));
    expect(recorded(s.published)).toHaveLength(0);
  });
});

describe("idempotency (criterion 2)", () => {
  it("one transaction and one event for the same receipt twice", async () => {
    const s = await seeded();
    const ev = receipt({ memo: "AN", ref: "dup", amount: 70_000 });
    await s.handle(ev);
    await s.handle(ev);
    expect(s.store.get("u1")!.transactions).toHaveLength(1);
    expect(recorded(s.published)).toHaveLength(1);
    expect(balanceOf(s).spentVnd).toBe(70_000);
  });

  it("re-publishes once after a failed publish, without a second transaction", async () => {
    const s = await seeded();
    const ev = receipt({ memo: "AN", ref: "retry" });
    s.fail.publish = true;
    await expect(s.handle(ev)).rejects.toThrow("bus down");
    expect(s.store.get("u1")!.transactions).toHaveLength(1);
    s.fail.publish = false;
    await s.handle(ev);
    await s.handle(ev);
    expect(s.store.get("u1")!.transactions).toHaveLength(1);
    expect(recorded(s.published)).toHaveLength(1);
  });
});

describe("classifyCodedTransfer", () => {
  const categories = [
    { id: "c1", shortCode: "AN", bankAccountId: "a1" },
    { id: "c2", shortCode: "XE", bankAccountId: "a1" },
  ];
  const accounts = [
    { id: "a1", code: "MAIN" },
    { id: "a2", code: "SAV" },
  ];
  const base = { direction: "out" as const, amountVnd: 1000, bankAccountHint: "main" };

  it.each([
    ["short code", { ...base, memo: "AN" }, "c1"],
    ["lower case", { ...base, memo: "xe" }, "c2"],
    ["punctuation", { ...base, memo: " a.n " }, "c1"],
    ["diacritics", { ...base, memo: "ăn" }, "c1"],
    ["unknown code", { ...base, memo: "ZZ" }, undefined],
    ["free text", { ...base, memo: "an trua" }, undefined],
    ["funding code", { ...base, memo: "MW-F-C01-MAIN" }, undefined],
    ["incoming money", { ...base, direction: "in" as const, memo: "AN" }, undefined],
    ["unresolved account", { ...base, bankAccountHint: "NOPE", memo: "AN" }, undefined],
    ["zero amount", { ...base, amountVnd: 0, memo: "AN" }, undefined],
  ])("%s", (_n, r, expected) => {
    const result = classifyCodedTransfer(r, categories, accounts);
    expect(result?.categoryId).toBe(expected);
    if (result) {
      expect(result.transactionType).toBe("coded_unplanned");
      expect(result.reconciliationResult).toBe("unplanned");
      expect(result.bankAccountId).toBe(r.bankAccountHint.toUpperCase() === "MAIN" ? "a1" : "a2");
    }
  });
});
