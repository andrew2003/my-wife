import { describe, expect, it, vi } from "vitest";
import type { EventEnvelope } from "@my-wife/contracts";
import { createOnboardingHandler, MemorySampleBudgetStore } from "../src/onboarding";
import { createForeignCardHandler, isForeignCardReceipt } from "../src/foreign-card";
import { createTransactionHandler, getCategoryBalances } from "../src/transactions";
import { createBankEventHandler } from "../src/bank-event-wiring";

const NOW = new Date("2026-03-05T10:00:00Z");

interface Opts {
  ref: string;
  amountVnd: number;
  currency?: string;
  foreignAmountMinor?: number;
  direction?: "in" | "out";
  memo?: string;
}

function receipt(o: Opts) {
  return {
    id: `ev-${o.ref}`,
    type: "receipt.parsed",
    occurredAt: NOW.toISOString(),
    userId: "u1",
    schemaVersion: 1,
    payload: {
      receiptId: `r-${o.ref}`,
      bankTransactionRef: o.ref,
      bankAccountHint: "MAIN",
      direction: o.direction ?? "out",
      amountVnd: o.amountVnd,
      currency: o.currency ?? "USD",
      ...(o.foreignAmountMinor === undefined ? {} : { foreignAmountMinor: o.foreignAmountMinor }),
      counterparty: null,
      memo: o.memo ?? "GOOGLE*YouTube",
      occurredAt: NOW.toISOString(),
      source: "email",
      fxProvisional: false,
    },
  } as unknown as EventEnvelope;
}

async function seeded() {
  const store = new MemorySampleBudgetStore();
  let n = 0;
  const newId = () => `id-${++n}`;
  await createOnboardingHandler({
    store,
    locale: "en",
    now: () => NOW,
    newId,
    publish: () => undefined,
  })({
    id: "e0",
    type: "onboarding.step_completed",
    occurredAt: NOW.toISOString(),
    userId: "u1",
    schemaVersion: 1,
    payload: { step: "qa_templates", skipped: true },
  } as EventEnvelope);
  store.get("u1")!.cycle.state = "running";
  const published: EventEnvelope[] = [];
  const publish = (e: EventEnvelope) => void published.push(e);
  const fxProvider = vi.fn(async () => 25_000);
  const foreign = createForeignCardHandler({ store, now: () => NOW, newId, publish, fxProvider });
  const coded = createTransactionHandler({ store, now: () => NOW, newId, publish });
  const bank = createBankEventHandler({ store, locale: "en", now: () => NOW, newId, publish });
  const handle = async (e: EventEnvelope) => {
    await coded(e);
    await bank(e);
    await foreign(e);
  };
  return { store, handle, published, fxProvider };
}

describe("isForeignCardReceipt", () => {
  const base = { direction: "out" as const, amountVnd: 1, currency: "USD" };
  it.each([
    ["USD out", base, true],
    ["lowercase code", { ...base, currency: "usd" }, true],
    ["VND", { ...base, currency: "VND" }, false],
    ["incoming", { ...base, direction: "in" as const }, false],
    ["zero VND (no VND in the email)", { ...base, amountVnd: 0 }, false],
  ])("%s", (_n, r, expected) => {
    expect(isForeignCardReceipt(r)).toBe(expected);
  });
});

describe("foreign card payment", () => {
  it("books the VND amount from the email and never calls the FX provider", async () => {
    const s = await seeded();
    await s.handle(receipt({ ref: "F1", amountVnd: 254_321, foreignAmountMinor: 999 }));
    const rec = s.store.get("u1")!;
    expect(rec.transactions).toHaveLength(1);
    expect(rec.transactions[0]).toMatchObject({
      transactionType: "foreign_card",
      direction: "out",
      amountVnd: 254_321,
      currency: "USD",
      foreignAmountMinor: 999,
      categoryId: null,
      reconciliationResult: "unknown",
    });
    expect(s.fxProvider).not.toHaveBeenCalled();
    expect(rec.audit.filter((a) => a.action === "transaction_recorded")).toHaveLength(1);
    expect(s.published.map((e) => e.type)).toEqual(["txn.recorded"]);
    expect(getCategoryBalances(rec).every((b) => b.spentVnd === 0)).toBe(true);
  });

  it("is idempotent per bank transaction ref", async () => {
    const s = await seeded();
    const e = receipt({ ref: "F1", amountVnd: 100_000 });
    await s.handle(e);
    await s.handle(e);
    expect(s.store.get("u1")!.transactions).toHaveLength(1);
    expect(s.published).toHaveLength(1);
  });

  it.each([
    ["VND receipt", { currency: "VND" }],
    ["incoming", { direction: "in" as const }],
    ["no VND amount", { amountVnd: 0 }],
  ])("ignores %s", async (_n, o) => {
    const s = await seeded();
    await s.handle(receipt({ ref: "X1", amountVnd: 50_000, memo: "coffee", ...o }));
    expect(s.store.get("u1")!.transactions).toHaveLength(0);
    expect(s.fxProvider).not.toHaveBeenCalled();
  });

  it("does nothing when the cycle is not running", async () => {
    const s = await seeded();
    s.store.get("u1")!.cycle.state = "draft";
    await s.handle(receipt({ ref: "F1", amountVnd: 100_000 }));
    expect(s.store.get("u1")!.transactions).toHaveLength(0);
  });
});
