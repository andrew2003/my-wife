import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "@my-wife/contracts";
import { createOnboardingHandler, MemorySampleBudgetStore } from "../src/onboarding";
import { createUnknownSpendHandlers, type UnknownReceipt } from "../src/unknown-spend";
import { getCategoryBalances } from "../src/transactions";

const NOW = new Date("2026-03-05T10:00:00Z");
const LATER = new Date("2026-03-05T12:00:00Z");

const unknownEvent = (receiptId = "r1", userId = "u1"): EventEnvelope =>
  ({
    id: `ev-${receiptId}`,
    type: "receipt.unknown",
    occurredAt: NOW.toISOString(),
    userId,
    schemaVersion: 1,
    payload: { receiptId, templateFingerprint: "fp", sender: "alerts@bank.example" },
  }) as unknown as EventEnvelope;

const reply = (questionId: string, value: string, sourceService = "budget"): EventEnvelope =>
  ({
    id: `rep-${questionId}-${value}`,
    type: "notify.reply_received",
    occurredAt: LATER.toISOString(),
    userId: "u1",
    schemaVersion: 1,
    payload: {
      questionId,
      sourceService,
      kind: "budget_category",
      value,
      answeredAt: LATER.toISOString(),
      via: "chat",
    },
  }) as unknown as EventEnvelope;

function receiptOf(amountVnd: number, ref = "ref-1"): UnknownReceipt {
  return {
    bankTransactionRef: ref,
    bankAccountHint: "MAIN",
    direction: "out",
    amountVnd,
    occurredAt: NOW.toISOString(),
    memo: "coffee shop",
    counterparty: null,
  };
}

async function seeded(opts: { amount?: number; hours?: number; state?: "running" | "draft" } = {}) {
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
  record.cycle.state = opts.state ?? "running";
  const published: EventEnvelope[] = [];
  const fail = { publish: false };
  const h = createUnknownSpendHandlers({
    store,
    now: () => NOW,
    newId: () => `id-${++n}`,
    publish: (e) => {
      if (fail.publish) throw new Error("bus down");
      published.push(e);
    },
    readReceipt: async () => receiptOf(opts.amount ?? 80_000),
    readSettings: async () =>
      opts.hours === undefined ? {} : { "budget.unknown_deadline_hours": opts.hours },
  });
  return { store, record, h, published, fail };
}

const ofType = (p: EventEnvelope[], type: string) => p.filter((e) => e.type === type);

describe("receipt.unknown opens an anomaly and asks (criterion 1)", () => {
  it("emits anomaly.opened and ask.budget_category for 80,000 VND", async () => {
    const s = await seeded();
    await s.h.onReceiptUnknown(unknownEvent());
    const opened = ofType(s.published, "anomaly.opened") as EventEnvelope<"anomaly.opened">[];
    const ask = ofType(
      s.published,
      "ask.budget_category",
    ) as EventEnvelope<"ask.budget_category">[];
    expect(opened).toHaveLength(1);
    expect(ask).toHaveLength(1);
    expect(opened[0]!.payload.kind).toBe("unknown_receipt");
    expect(ask[0]!.payload.kind).toBe("budget_category");
    expect(ask[0]!.payload.params).toMatchObject({ amountVnd: 80_000 });
    expect(ask[0]!.payload.options.map((o) => o.value)).toEqual(
      s.record.categories.filter((c) => c.kind === "variable").map((c) => c.id),
    );
    expect(s.store.get("u1")!.audit.some((a) => a.action === "anomaly_opened")).toBe(true);
  });

  it("sets the question expiry from budget.unknown_deadline_hours", async () => {
    const table = [
      { hours: undefined, expected: "2026-03-06T10:00:00.000Z" },
      { hours: 48, expected: "2026-03-07T10:00:00.000Z" },
      { hours: 1, expected: "2026-03-05T11:00:00.000Z" },
    ];
    for (const row of table) {
      const s = await seeded({ hours: row.hours });
      await s.h.onReceiptUnknown(unknownEvent());
      const ask = ofType(
        s.published,
        "ask.budget_category",
      )[0] as EventEnvelope<"ask.budget_category">;
      expect(ask.payload.expiresAt).toBe(row.expected);
    }
  });

  it("is idempotent and does not book anything before the answer", async () => {
    const s = await seeded();
    await s.h.onReceiptUnknown(unknownEvent());
    await s.h.onReceiptUnknown(unknownEvent());
    expect(ofType(s.published, "anomaly.opened")).toHaveLength(1);
    expect(ofType(s.published, "ask.budget_category")).toHaveLength(1);
    expect(s.store.get("u1")!.transactions).toHaveLength(0);
  });

  it("retries a failed publish on the next delivery without opening twice", async () => {
    const s = await seeded();
    s.fail.publish = true;
    await expect(s.h.onReceiptUnknown(unknownEvent())).rejects.toThrow();
    s.fail.publish = false;
    await s.h.onReceiptUnknown(unknownEvent());
    expect(ofType(s.published, "anomaly.opened")).toHaveLength(1);
    expect(ofType(s.published, "ask.budget_category")).toHaveLength(1);
    expect(s.store.get("u1")!.anomalies).toHaveLength(1);
  });

  it("does nothing when the receipt cannot be read or the cycle is not running", async () => {
    const s = await seeded({ state: "draft" });
    await s.h.onReceiptUnknown(unknownEvent());
    expect(s.published).toHaveLength(0);
    const t = await seeded();
    const h = createUnknownSpendHandlers({
      store: t.store,
      now: () => NOW,
      newId: () => "x",
      publish: (e) => void t.published.push(e),
      readReceipt: async () => undefined,
    });
    await h.onReceiptUnknown(unknownEvent());
    expect(t.published).toHaveLength(0);
  });
});

describe("the answer books the transaction (criterion 2)", () => {
  async function opened(amount = 80_000) {
    const s = await seeded({ amount });
    await s.h.onReceiptUnknown(unknownEvent());
    const ask = ofType(
      s.published,
      "ask.budget_category",
    )[0] as EventEnvelope<"ask.budget_category">;
    const category = s.record.categories.find((c) => c.id === ask.payload.options[0]!.value)!;
    return { s, ask, category };
  }
  const spent = (s: Awaited<ReturnType<typeof seeded>>, id: string) =>
    getCategoryBalances(s.store.get("u1")!).find((b) => b.categoryId === id)!.spentVnd;

  it.each([80_000, 1, 1_234_567])(
    "books %i VND there and emits anomaly.resolved",
    async (amount) => {
      const { s, ask, category } = await opened(amount);
      await s.h.onReplyReceived(reply(ask.payload.questionId, category.id));
      expect(spent(s, category.id)).toBe(amount);
      const resolved = ofType(
        s.published,
        "anomaly.resolved",
      ) as EventEnvelope<"anomaly.resolved">[];
      expect(resolved).toHaveLength(1);
      expect(resolved[0]!.payload.resolution).toBe(`category:${category.id}`);
      const txn = ofType(s.published, "txn.recorded") as EventEnvelope<"txn.recorded">[];
      expect(txn).toHaveLength(1);
      expect(txn[0]!.payload).toMatchObject({ amountVnd: amount, categoryId: category.id });
      const audit = s.store.get("u1")!.audit.map((a) => a.action);
      expect(audit).toContain("anomaly_resolved");
      expect(audit).toContain("transaction_recorded");
    },
  );

  it("ignores a second reply, other sources, unknown questions and non-category values", async () => {
    const { s, ask, category } = await opened();
    await s.h.onReplyReceived(reply("nope", category.id));
    await s.h.onReplyReceived(reply(ask.payload.questionId, category.id, "schedule"));
    await s.h.onReplyReceived(reply(ask.payload.questionId, "not-a-category"));
    expect(ofType(s.published, "anomaly.resolved")).toHaveLength(0);
    await s.h.onReplyReceived(reply(ask.payload.questionId, category.id));
    const other = s.record.categories.find((c) => c.id !== category.id)!;
    await s.h.onReplyReceived(reply(ask.payload.questionId, other.id));
    expect(ofType(s.published, "anomaly.resolved")).toHaveLength(1);
    expect(s.store.get("u1")!.transactions).toHaveLength(1);
    expect(spent(s, other.id)).toBe(0);
  });

  it("retries a failed resolved publish without booking twice", async () => {
    const { s, ask, category } = await opened();
    s.fail.publish = true;
    await expect(s.h.onReplyReceived(reply(ask.payload.questionId, category.id))).rejects.toThrow();
    s.fail.publish = false;
    await s.h.onReplyReceived(reply(ask.payload.questionId, category.id));
    expect(ofType(s.published, "anomaly.resolved")).toHaveLength(1);
    expect(s.store.get("u1")!.transactions).toHaveLength(1);
  });
});

describe("anomaly.opened reaches the user only through the inbox (criterion 3)", () => {
  it("the chat question is only ask.budget_category; the anomaly carries no second ask event", async () => {
    const s = await seeded();
    await s.h.onReceiptUnknown(unknownEvent());
    const chatEvents = s.published.filter((e) => e.type.startsWith("ask."));
    expect(chatEvents.map((e) => e.type)).toEqual(["ask.budget_category"]);
    const opened = ofType(s.published, "anomaly.opened")[0] as EventEnvelope<"anomaly.opened">;
    const ask = chatEvents[0] as EventEnvelope<"ask.budget_category">;
    expect(opened.payload.question?.questionId).toBe(ask.payload.questionId);
  });
});
