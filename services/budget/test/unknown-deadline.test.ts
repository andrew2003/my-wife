import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "@my-wife/contracts";
import { createOnboardingHandler, MemorySampleBudgetStore } from "../src/onboarding";
import {
  createUnknownDeadlineJob,
  createUnknownSpendHandlers,
  pickWantCategory,
  type UnknownReceipt,
} from "../src/unknown-spend";
import { getCategoryBalances } from "../src/transactions";

const NOW = new Date("2026-03-05T10:00:00Z");
const at = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);

const unknownEvent = (receiptId: string): EventEnvelope =>
  ({
    id: `ev-${receiptId}`,
    type: "receipt.unknown",
    occurredAt: NOW.toISOString(),
    userId: "u1",
    schemaVersion: 1,
    payload: { receiptId, templateFingerprint: "fp", sender: "alerts@bank.example" },
  }) as unknown as EventEnvelope;

async function seeded(opts: { hours?: number; amount?: number } = {}) {
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
  const fail = { publish: false };
  const publish = (e: EventEnvelope) => {
    if (fail.publish) throw new Error("bus down");
    published.push(e);
  };
  const handlers = createUnknownSpendHandlers({
    store,
    now: () => NOW,
    newId,
    publish,
    readReceipt: async (_u, id): Promise<UnknownReceipt> => ({
      bankTransactionRef: `ref-${id}`,
      bankAccountHint: "MAIN",
      direction: "out",
      amountVnd: opts.amount ?? 80_000,
      occurredAt: NOW.toISOString(),
      memo: "coffee shop",
      counterparty: null,
    }),
    readSettings: async () =>
      opts.hours === undefined ? {} : { "budget.unknown_deadline_hours": opts.hours },
  });
  const job = createUnknownDeadlineJob({ store, newId, publish });
  return { store, handlers, job, published, fail };
}

const ofType = (p: EventEnvelope[], type: string) => p.filter((e) => e.type === type);

describe("unknown spend is booked after the deadline (MW-060)", () => {
  const rows = [
    { name: "default 24h, just before", hours: undefined, after: 23, booked: false },
    { name: "default 24h, at the deadline", hours: undefined, after: 24, booked: true },
    { name: "default 24h, long after", hours: undefined, after: 100, booked: true },
    { name: "48h setting, at 24h", hours: 48, after: 24, booked: false },
    { name: "48h setting, at 48h", hours: 48, after: 48, booked: true },
    { name: "1h setting, at 1h", hours: 1, after: 1, booked: true },
  ];
  for (const row of rows) {
    it(row.name, async () => {
      const s = await seeded({ hours: row.hours });
      await s.handlers.onReceiptUnknown(unknownEvent("r1"));
      await s.job.run("u1", at(row.after));
      expect(s.store.get("u1")!.transactions).toHaveLength(row.booked ? 1 : 0);
      expect(ofType(s.published, "anomaly.resolved")).toHaveLength(row.booked ? 1 : 0);
    });
  }

  it("books to the first want category and tells the user", async () => {
    const s = await seeded();
    await s.handlers.onReceiptUnknown(unknownEvent("r1"));
    await s.job.run("u1", at(24));
    const record = s.store.get("u1")!;
    const first = [...record.categories]
      .filter((c) => c.priority === "want")
      .sort((a, b) => (a.wantOrder ?? 99) - (b.wantOrder ?? 99))[0]!;
    const txn = record.transactions[0]!;
    expect(txn.categoryId).toBe(first.id);
    expect(txn.amountVnd).toBe(80_000);
    expect(getCategoryBalances(record).find((b) => b.categoryId === first.id)!.spentVnd).toBe(
      80_000,
    );
    const resolved = ofType(
      s.published,
      "anomaly.resolved",
    )[0] as EventEnvelope<"anomaly.resolved">;
    expect(resolved.payload.resolution).toBe(`deadline:category:${first.id}`);
    expect(ofType(s.published, "txn.recorded")).toHaveLength(1);
    expect(record.audit.some((a) => a.action === "anomaly_resolved")).toBe(true);
  });

  it("is idempotent", async () => {
    const s = await seeded();
    await s.handlers.onReceiptUnknown(unknownEvent("r1"));
    await s.job.run("u1", at(30));
    await s.job.run("u1", at(31));
    expect(s.store.get("u1")!.transactions).toHaveLength(1);
    expect(ofType(s.published, "anomaly.resolved")).toHaveLength(1);
  });

  it("retries a failed publish without booking twice", async () => {
    const s = await seeded();
    await s.handlers.onReceiptUnknown(unknownEvent("r1"));
    s.fail.publish = true;
    await expect(s.job.run("u1", at(30))).rejects.toThrow();
    s.fail.publish = false;
    await s.job.run("u1", at(31));
    expect(s.store.get("u1")!.transactions).toHaveLength(1);
    expect(ofType(s.published, "anomaly.resolved")).toHaveLength(1);
    expect(ofType(s.published, "txn.recorded")).toHaveLength(1);
  });
});

describe("pickWantCategory", () => {
  const cat = (id: string, wantOrder: number | null, priority = "want") => ({
    id,
    priority,
    wantOrder,
    cycleLimitVnd: 100_000,
  });
  const table = [
    {
      name: "first with room",
      cats: [cat("b", 2), cat("a", 1)],
      spent: {},
      amount: 50_000,
      id: "a",
    },
    {
      name: "skips a full one",
      cats: [cat("a", 1), cat("b", 2)],
      spent: { a: 90_000 },
      amount: 50_000,
      id: "b",
    },
    {
      name: "none with room: first",
      cats: [cat("a", 1), cat("b", 2)],
      spent: { a: 100_000, b: 100_000 },
      amount: 5,
      id: "a",
    },
    {
      name: "ignores non-want",
      cats: [cat("n", null, "need"), cat("w", 1)],
      spent: {},
      amount: 1,
      id: "w",
    },
    {
      name: "no want category",
      cats: [cat("n", null, "need")],
      spent: {},
      amount: 1,
      id: undefined,
    },
  ];
  for (const row of table) {
    it(row.name, () => {
      const balances = row.cats.map((c) => {
        const spentVnd = (row.spent as Record<string, number>)[c.id] ?? 0;
        return {
          categoryId: c.id,
          limitVnd: c.cycleLimitVnd,
          spentVnd,
          balanceVnd: c.cycleLimitVnd - spentVnd,
        };
      });
      expect(pickWantCategory(row.cats as never, balances, row.amount)?.id).toBe(row.id);
    });
  }
});
