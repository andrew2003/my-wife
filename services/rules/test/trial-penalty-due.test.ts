import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import type { EventEnvelope } from "@my-wife/contracts";
import { createApp } from "../src/app";
import { InMemoryPenaltyStore } from "../src/penalty";

const USER = "11111111-1111-4111-8111-111111111111";
const CYCLE = "22222222-2222-4222-8222-222222222222";
const CAT = "55555555-5555-4555-8555-555555555555";
const CONTRACT = "33333333-3333-4333-8333-333333333333";
const RECEIPT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DAY = 86_400_000;
const T0 = new Date("2026-11-26T03:00:00.000Z");
const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });

const env = (type: string, payload: unknown, at: Date): EventEnvelope =>
  ({
    id: randomUUID(),
    type,
    userId: USER,
    occurredAt: at.toISOString(),
    schemaVersion: 1,
    payload,
  }) as EventEnvelope;

async function boot(opts: { installmentsK: number; excess: number }) {
  const events: EventEnvelope[] = [];
  const penaltyStore = new InMemoryPenaltyStore();
  let clock = T0;
  const app = createApp(config, {
    publish: (e) => void events.push(e),
    penaltyStore,
    now: () => clock,
    readTrialSettings: async () => ({
      weeks: 1,
      installmentsK: opts.installmentsK,
      finalAppealHours: 0,
    }),
    resolveTransferCode: async () => "MW-PH-C1W1-FUN",
    isPenaltySavingsAccount: async (_u, hint) => hint === "9999",
  });
  const post = (url: string, e: EventEnvelope) => app.inject({ method: "POST", url, payload: e });
  await post(
    "/events/contract-signed",
    env("contract.signed", { contractId: CONTRACT, cycleId: CYCLE, version: 1 }, T0),
  );
  await post(
    "/events/overspend-detected",
    env(
      "overspend.detected",
      {
        cycleId: CYCLE,
        weekIndex: 1,
        categoryId: CAT,
        priority: "want",
        weeklyLimitVnd: 200_000,
        spentVnd: 200_000 + opts.excess,
        excessVnd: opts.excess,
      },
      T0,
    ),
  );
  const settle = async () => {
    clock = new Date(T0.getTime() + 8 * DAY);
    await app.runTrialJob!(clock);
  };
  return { app, events, penaltyStore, post, settle };
}

describe("trial settlement moves suspended penalties to due (#280)", () => {
  const cases = [
    { name: "one payment", installmentsK: 1, excess: 50_000, amount: 50_000 },
    {
      name: "K installments keep the whole amount payable",
      installmentsK: 4,
      excess: 100_000,
      amount: 100_000,
    },
  ];
  it.each(cases)("$name", async ({ installmentsK, excess, amount }) => {
    const { events, penaltyStore, settle } = await boot({ installmentsK, excess });
    expect(penaltyStore.list(USER)[0]).toMatchObject({ status: "suspended", amountVnd: amount });
    expect(events.some((e) => e.type === "penalty.issued")).toBe(false);
    await settle();
    const entry = penaltyStore.list(USER)[0]!;
    expect(entry.status).toBe("due");
    const issued = events.filter((e) => e.type === "penalty.issued");
    expect(issued).toHaveLength(1);
    expect(issued[0]!.payload).toMatchObject({
      penaltyId: entry.id,
      amountVnd: amount,
      transferCode: "MW-PH-C1W1-FUN",
    });
    expect(penaltyStore.audit(USER).map((a) => a.action)).toEqual([
      "penalty.created",
      "penalty.due",
    ]);
    // Running the job again neither re-issues nor re-audits.
    await settle();
    expect(events.filter((e) => e.type === "penalty.issued")).toHaveLength(1);
    expect(penaltyStore.audit(USER)).toHaveLength(2);
  });
});

describe("penalty account hint (#281)", () => {
  const mail = (hint: string, amountVnd: number, memo: string) =>
    env(
      "receipt.parsed",
      {
        receiptId: RECEIPT,
        bankTransactionRef: "REF-1",
        bankAccountHint: hint,
        direction: "in",
        amountVnd,
        currency: "VND",
        counterparty: null,
        memo,
        occurredAt: T0.toISOString(),
        source: "parser",
        fxProvisional: false,
      },
      T0,
    );
  const cases = [
    { name: "digit hint of the penalty account, exact", hint: "9999", amount: 50_000, paid: true },
    { name: "more than the penalty", hint: "9999", amount: 60_000, paid: true },
    { name: "other digit account", hint: "1234", amount: 50_000, paid: false },
    { name: "less than the penalty", hint: "9999", amount: 49_999, paid: false },
  ];
  it.each(cases)("$name", async ({ hint, amount, paid }) => {
    const { events, post, settle } = await boot({ installmentsK: 1, excess: 50_000 });
    await settle();
    await post("/events/receipt-parsed", mail(hint, amount, "MW-PH-C1W1-FUN"));
    expect(events.some((e) => e.type === "penalty.paid")).toBe(paid);
  });

  it("without injected resolvers the default still ignores a digit hint", async () => {
    const events: EventEnvelope[] = [];
    const app = createApp(config, { publish: (e) => void events.push(e) });
    const res = await app.inject({
      method: "POST",
      url: "/events/receipt-parsed",
      payload: mail("1234", 50_000, "MW-PH-C1W1-FUN"),
    });
    expect(res.statusCode).toBe(200);
    expect(events).toHaveLength(0);
  });
});
