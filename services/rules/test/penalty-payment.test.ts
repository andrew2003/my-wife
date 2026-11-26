import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "@my-wife/contracts";
import { InMemoryPenaltyStore, createPenaltyService } from "../src/penalty";
import { InMemoryTrialStore } from "../src/trial";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const CYCLE = "22222222-2222-4222-8222-222222222222";
const CAT = "55555555-5555-4555-8555-555555555555";
const RECEIPT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const T0 = new Date("2026-11-26T03:00:00.000Z");
const T1 = new Date("2026-11-27T03:00:00.000Z");
const CODE = "MW-PH-C22222222W2-55555555";

function ids() {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
}

function overspend(weekIndex = 2, id = "evt-1"): EventEnvelope {
  return {
    id,
    type: "overspend.detected",
    userId: USER,
    occurredAt: T0.toISOString(),
    schemaVersion: 1,
    payload: {
      cycleId: CYCLE,
      weekIndex,
      categoryId: CAT,
      priority: "want",
      weeklyLimitVnd: 200_000,
      spentVnd: 250_000,
      excessVnd: 50_000,
    },
  } as EventEnvelope;
}

type Receipt = Partial<{
  userId: string;
  receiptId: string;
  ref: string;
  hint: string;
  direction: string;
  amountVnd: number;
  memo: string;
}>;

function receipt(o: Receipt = {}): EventEnvelope {
  return {
    id: `evt-${o.ref ?? "r1"}`,
    type: "receipt.parsed",
    userId: o.userId ?? USER,
    occurredAt: T1.toISOString(),
    schemaVersion: 1,
    payload: {
      receiptId: o.receiptId ?? RECEIPT,
      bankTransactionRef: o.ref ?? "REF-1",
      bankAccountHint: o.hint ?? "PEN",
      direction: o.direction ?? "in",
      amountVnd: o.amountVnd ?? 50_000,
      currency: "VND",
      counterparty: null,
      memo: o.memo ?? CODE,
      occurredAt: T1.toISOString(),
      source: "email",
      fxProvisional: false,
    },
  } as EventEnvelope;
}

async function setup(publishFails = false) {
  const events: EventEnvelope[] = [];
  const state = { fail: publishFails };
  const store = new InMemoryPenaltyStore();
  const service = createPenaltyService({
    store,
    trialStore: new InMemoryTrialStore(),
    publish: (e) => {
      if (state.fail && e.type === "penalty.paid") throw new Error("bus down");
      events.push(e);
    },
    newId: ids(),
    resolveTransferCode: async (_u, r) => `MW-PH-C22222222W${r.weekIndex}-55555555`,
  });
  await service.onOverspendDetected(overspend(), T0);
  return { events, store, service, state };
}

describe("onReceiptParsed: penalty payment", () => {
  it("a coded transfer to penalty savings marks the entry paid and emits penalty.paid", async () => {
    const { events, store, service } = await setup();
    const r = await service.onReceiptParsed(receipt(), T1);
    expect(r).toMatchObject({ status: "paid", duplicate: false });
    expect(store.list(USER)[0]).toMatchObject({ status: "paid", paymentTransactionId: RECEIPT });
    const paid = events.filter((e) => e.type === "penalty.paid");
    expect(paid).toHaveLength(1);
    expect(paid[0]!.payload).toMatchObject({
      penaltyId: store.list(USER)[0]!.id,
      source: "overspend",
      amountVnd: 50_000,
      transactionId: RECEIPT,
    });
    expect(store.audit(USER).map((a) => a.action)).toEqual(["penalty.created", "penalty.paid"]);
    expect(store.list(USER)[0]!.auditRefs).toHaveLength(2);
  });

  const accepted = [
    {
      name: "memo with spaces, case and diacritics",
      o: { memo: "chuyển mw ph c22222222w2 55555555 ok" },
    },
    { name: "amount above the penalty", o: { amountVnd: 70_000 } },
    { name: "hint in lower case", o: { hint: "pen" } },
  ];
  it.each(accepted)("pays: $name", async ({ o }) => {
    const { store, service } = await setup();
    await service.onReceiptParsed(receipt(o), T1);
    expect(store.list(USER)[0]!.status).toBe("paid");
  });

  const rejected = [
    { name: "amount below the penalty", o: { amountVnd: 49_999 } },
    { name: "not the penalty savings account", o: { hint: "SAV" } },
    { name: "outgoing direction", o: { direction: "out" } },
    { name: "memo without the code", o: { memo: "thanks" } },
    { name: "another user", o: { userId: OTHER } },
  ];
  it.each(rejected)("changes nothing: $name", async ({ o }) => {
    const { events, store, service } = await setup();
    const r = await service.onReceiptParsed(receipt(o), T1);
    expect(r.status).toBe("ignored");
    expect(store.list(USER)[0]!.status).toBe("due");
    expect(events.map((e) => e.type)).toEqual(["penalty.issued"]);
  });

  it("a redelivered receipt pays once", async () => {
    const { events, store, service } = await setup();
    await service.onReceiptParsed(receipt(), T1);
    const again = await service.onReceiptParsed(receipt(), T1);
    expect(again.status).toBe("ignored");
    expect(events.filter((e) => e.type === "penalty.paid")).toHaveLength(1);
    expect(store.audit(USER)).toHaveLength(2);
  });

  it("a suspended entry is not payable", async () => {
    const trialStore = new InMemoryTrialStore();
    trialStore.create({
      userId: USER,
      settings: { weeks: 4, installmentsK: 1, finalAppealHours: 72 },
      startedAt: T0.toISOString(),
      endsAt: new Date(T0.getTime() + 28 * 86_400_000).toISOString(),
      state: "active",
      startedPublished: true,
      endedPublished: false,
      settledPublished: false,
    });
    const store = new InMemoryPenaltyStore();
    const service = createPenaltyService({
      store,
      trialStore,
      newId: ids(),
      resolveTransferCode: async () => CODE,
    });
    await service.onOverspendDetected(overspend(), T0);
    expect((await service.onReceiptParsed(receipt(), T1)).status).toBe("ignored");
    expect(store.list(USER)[0]!.status).toBe("suspended");
  });

  it("a failed publish is retried by the next delivery without paying twice", async () => {
    const { events, store, service, state } = await setup(true);
    await service.onReceiptParsed(receipt(), T1);
    expect(store.list(USER)[0]!.status).toBe("paid");
    expect(events.filter((e) => e.type === "penalty.paid")).toHaveLength(0);
    state.fail = false;
    await service.onReceiptParsed(receipt(), T1);
    expect(events.filter((e) => e.type === "penalty.paid")).toHaveLength(1);
    expect(store.audit(USER)).toHaveLength(2);
  });

  it("only the entry whose code is in the memo is paid, and one reference pays once", async () => {
    const { store, service } = await setup();
    await service.onOverspendDetected(overspend(21, "evt-2"), T0);
    // Only the entry whose code is in the memo is paid.
    await service.onReceiptParsed(receipt({ memo: "MW-PH-C22222222W21-55555555" }), T1);
    expect(store.list(USER).map((e) => e.status)).toEqual(["due", "paid"]);
    await service.onReceiptParsed(
      receipt({ receiptId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }),
      T1,
    );
    expect(store.list(USER).map((e) => e.status)).toEqual(["due", "paid"]);
  });

  it("the penalty savings account is configurable", async () => {
    const store = new InMemoryPenaltyStore();
    const service = createPenaltyService({
      store,
      trialStore: new InMemoryTrialStore(),
      newId: ids(),
      resolveTransferCode: async () => CODE,
      isPenaltySavingsAccount: async (_u, hint) => hint === "BOX",
    });
    await service.onOverspendDetected(overspend(), T0);
    expect((await service.onReceiptParsed(receipt(), T1)).status).toBe("ignored");
    expect((await service.onReceiptParsed(receipt({ hint: "BOX", ref: "REF-2" }), T1)).status).toBe(
      "paid",
    );
  });
});
