import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "@my-wife/contracts";
import { createOnboardingHandler, MemorySampleBudgetStore } from "../src/onboarding";
import { createTransactionHandler, getCategoryBalances } from "../src/transactions";

const NOW = new Date("2026-03-05T10:00:00Z");
const LATER = new Date("2026-03-06T10:00:00Z");
const PREVIOUS_ID = "prev-cycle";

function receipt(o: {
  memo: string;
  ref: string;
  amount?: number;
  direction?: "in" | "out";
}): EventEnvelope {
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

interface SeedOptions {
  state?: "draft" | "awaiting_funds" | "running";
  previous?: "closing" | "closed" | "none";
}

async function seeded(o: SeedOptions = {}) {
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
  record.cycle.state = o.state ?? "awaiting_funds";
  const previous = o.previous ?? "closed";
  if (previous !== "none") {
    record.previousCycle = {
      id: PREVIOUS_ID,
      state: previous,
      categories: record.categories.map((c) => ({ id: `prev-${c.id}`, shortCode: c.shortCode })),
    };
  }
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
  const an = record.categories.find((c) => c.shortCode === "AN")!;
  return { store, record, handle, published, fail, an };
}

const PENALTY_EVENTS = [
  "overspend.detected",
  "penalty.applied",
  "penalty.charged",
  "fault.recorded",
];

describe("spending while the next cycle awaits funds (criterion 1)", () => {
  it.each(["closing", "closed"] as const)(
    "books it to the %s previous cycle as unplanned",
    async (previous) => {
      const s = await seeded({ previous });
      await s.handle(receipt({ memo: "an", ref: "t1", amount: 120_000 }));

      const txns = s.store.get("u1")!.transactions;
      expect(txns).toHaveLength(1);
      expect(txns[0]).toMatchObject({
        cycleId: PREVIOUS_ID,
        categoryId: `prev-${s.an.id}`,
        amountVnd: 120_000,
        direction: "out",
        transactionType: "coded_unplanned",
        reconciliationResult: "unplanned",
        bankAccountId: s.an.bankAccountId,
      });
      const events = s.published.filter((e) => e.type === "txn.recorded");
      expect(events).toHaveLength(1);
      expect((events[0] as EventEnvelope<"txn.recorded">).payload).toMatchObject({
        cycleId: PREVIOUS_ID,
        reconciliationResult: "unplanned",
      });
    },
  );

  it("leaves the awaiting cycle untouched and writes an audit record", async () => {
    const s = await seeded();
    await s.handle(receipt({ memo: "an", ref: "t1" }));
    const r = s.store.get("u1")!;
    expect(r.cycle.state).toBe("awaiting_funds");
    const audit = r.audit.filter((a) => a.action === "transaction_recorded");
    expect(audit).toHaveLength(1);
    expect(audit[0]!.detail).toMatchObject({
      cycleId: PREVIOUS_ID,
      bankTransactionRef: "t1",
      awaitingFunds: 1,
    });
  });

  // Even a spend far above any limit never produces a penalty or an overspend.
  it.each([
    { name: "small", amount: 1 },
    { name: "typical", amount: 250_000 },
    { name: "above the category limit", amount: 900_000_000 },
  ])("no penalty or overspend for a $name amount", async ({ amount }) => {
    const s = await seeded();
    await s.handle(receipt({ memo: "an", ref: "t1", amount }));
    const r = s.store.get("u1")!;
    expect(r.transactions[0]!.reconciliationResult).toBe("unplanned");
    expect(s.published.filter((e) => PENALTY_EVENTS.includes(e.type))).toHaveLength(0);
    expect(r.overspends).toHaveLength(0);
    expect(r.penaltyDebts).toHaveLength(0);
    expect(r.limitAdjustments).toHaveLength(0);
  });

  it("books each bankTransactionRef once", async () => {
    const s = await seeded();
    await s.handle(receipt({ memo: "an", ref: "t1" }));
    await s.handle(receipt({ memo: "an", ref: "t1" }));
    expect(s.store.get("u1")!.transactions).toHaveLength(1);
    expect(s.published.filter((e) => e.type === "txn.recorded")).toHaveLength(1);
  });

  it("retries a failed publish without booking twice", async () => {
    const s = await seeded();
    s.fail.publish = true;
    await expect(s.handle(receipt({ memo: "an", ref: "t1" }))).rejects.toThrow();
    s.fail.publish = false;
    await s.handle(receipt({ memo: "an", ref: "t1" }));
    expect(s.store.get("u1")!.transactions).toHaveLength(1);
    expect(s.published.filter((e) => e.type === "txn.recorded")).toHaveLength(1);
  });

  it.each([
    {
      name: "no previous cycle",
      opts: { previous: "none" as const },
      msg: { memo: "an", ref: "a" },
    },
    { name: "a draft cycle", opts: { state: "draft" as const }, msg: { memo: "an", ref: "b" } },
    { name: "incoming money", opts: {}, msg: { memo: "an", ref: "c", direction: "in" as const } },
    { name: "a free text memo", opts: {}, msg: { memo: "lunch with friends", ref: "d" } },
    { name: "a zero amount", opts: {}, msg: { memo: "an", ref: "e", amount: 0 } },
  ])("books nothing for $name", async ({ opts, msg }) => {
    const s = await seeded(opts);
    await s.handle(receipt(msg));
    expect(s.store.get("u1")!.transactions).toHaveLength(0);
    expect(s.published).toHaveLength(0);
  });

  it("does not count it in the new cycle balances", async () => {
    const s = await seeded();
    await s.handle(receipt({ memo: "an", ref: "t1", amount: 120_000 }));
    const b = getCategoryBalances(s.store.get("u1")!).find((x) => x.categoryId === s.an.id)!;
    expect(b.spentVnd).toBe(0);
  });
});
