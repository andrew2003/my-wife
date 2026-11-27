import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "@my-wife/contracts";
import { createOnboardingHandler, MemorySampleBudgetStore } from "../src/onboarding";
import { createPenaltySavingsWithdrawalHandler } from "../src/penalty-savings-withdrawal";
import { createTransactionHandler } from "../src/transactions";

const NOW = new Date("2026-03-05T10:00:00Z");

function receipt(o: {
  ref: string;
  amount: number;
  hint: string;
  direction?: "in" | "out";
  memo?: string;
}) {
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
      direction: o.direction ?? "out",
      amountVnd: o.amount,
      currency: "VND",
      counterparty: null,
      memo: o.memo ?? "",
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
  const detect = createPenaltySavingsWithdrawalHandler({ store, publish });
  const record = createTransactionHandler({ store, now: () => NOW, newId, publish });
  const penaltyAccountId = store.get("u1")!.accounts.find((a) => a.kind === "penalty_savings")!.id;
  return { store, detect, record, published, penaltyAccountId };
}

const withdrawals = (events: EventEnvelope[]) =>
  events.filter((e) => e.type === "penalty_savings.withdrawal_detected");

describe("penalty savings withdrawal detection", () => {
  it("emits penalty_savings.withdrawal_detected for an outflow from penalty savings", async () => {
    const s = await seeded();
    await s.detect(receipt({ ref: "T1", amount: 500_000, hint: "PEN", memo: "anything" }));
    const events = withdrawals(s.published);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      userId: "u1",
      schemaVersion: 1,
      payload: {
        bankAccountId: s.penaltyAccountId,
        amountVnd: 500_000,
        transactionId: null,
        detectedBy: "receipt",
      },
    });
  });

  it.each([
    ["spending account outflow", "MAIN", "out"],
    ["savings account outflow", "SAV", "out"],
    ["penalty savings inflow (a penalty payment)", "PEN", "in"],
    ["unknown account", "NOPE", "out"],
  ] as const)("does not emit for %s", async (_name, hint, direction) => {
    const s = await seeded();
    await s.detect(receipt({ ref: "T1", amount: 500_000, hint, direction }));
    expect(withdrawals(s.published)).toHaveLength(0);
  });

  it("matches the account code case-insensitively and ignores a zero amount", async () => {
    const s = await seeded();
    await s.detect(receipt({ ref: "T1", amount: 0, hint: "pen" }));
    expect(withdrawals(s.published)).toHaveLength(0);
    await s.detect(receipt({ ref: "T2", amount: 1, hint: " pen " }));
    expect(withdrawals(s.published)).toHaveLength(1);
  });

  it("uses a deterministic event id so a redelivery cannot flag twice", async () => {
    const s = await seeded();
    await s.detect(receipt({ ref: "T1", amount: 500_000, hint: "PEN" }));
    await s.detect(receipt({ ref: "T1", amount: 500_000, hint: "PEN" }));
    const ids = withdrawals(s.published).map((e) => e.id);
    expect(new Set(ids).size).toBe(1);
  });

  it("does nothing for a user without a budget record or for other event types", async () => {
    const s = await seeded();
    await s.detect({ ...receipt({ ref: "T1", amount: 5, hint: "PEN" }), userId: "ghost" });
    await s.detect({ ...receipt({ ref: "T2", amount: 5, hint: "PEN" }), type: "txn.recorded" });
    expect(withdrawals(s.published)).toHaveLength(0);
  });

  it("links the booked transaction when another rule recorded the outflow", async () => {
    const s = await seeded();
    const cat = s.store.get("u1")!.categories[0]!;
    const e = receipt({ ref: "T9", amount: 100_000, hint: "PEN", memo: cat.shortCode });
    await s.record(e);
    await s.detect(e);
    const booked = s.store.get("u1")!.transactions.find((t) => t.bankTransactionRef === "T9");
    expect(booked).toBeDefined();
    expect(withdrawals(s.published)[0]!.payload).toMatchObject({ transactionId: booked!.id });
  });
});
