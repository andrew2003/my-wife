import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "@my-wife/contracts";
import { createOnboardingHandler, MemorySampleBudgetStore } from "../src/onboarding";
import {
  balanceToleranceVnd,
  createBalanceCheck,
  evaluateBalance,
  MemoryBalanceSnapshotStore,
} from "../src/balance-check";
import type { TransactionRecord } from "../src/transactions";

const T0 = "2026-03-01T00:00:00.000Z";
const T1 = "2026-03-08T00:00:00.000Z";
const NOW = new Date("2026-03-08T01:00:00Z");

const txn = (
  direction: "in" | "out",
  amountVnd: number,
  occurredAt: string,
  bankAccountId = "acc",
) => ({ direction, amountVnd, occurredAt, bankAccountId });

describe("balanceToleranceVnd (pure)", () => {
  const cases = [
    { name: "default", settings: {}, expected: 1000 },
    { name: "custom", settings: { "budget.balance_tolerance_vnd": 5000 }, expected: 5000 },
    { name: "zero is allowed", settings: { "budget.balance_tolerance_vnd": 0 }, expected: 0 },
    {
      name: "invalid falls back",
      settings: { "budget.balance_tolerance_vnd": -1 },
      expected: 1000,
    },
  ];
  it.each(cases)("$name", ({ settings, expected }) => {
    expect(balanceToleranceVnd(settings)).toBe(expected);
  });
});

describe("evaluateBalance (pure)", () => {
  const previous = { balanceVnd: 1_000_000, takenAt: T0 };
  const cases = [
    {
      name: "ledger matches the balance",
      txns: [
        txn("in", 500_000, "2026-03-02T00:00:00Z"),
        txn("out", 200_000, "2026-03-03T00:00:00Z"),
      ],
      actual: 1_300_000,
      tol: 1000,
      expected: { expectedVnd: 1_300_000, differenceVnd: 0, exceeds: false },
    },
    {
      name: "missing outflow: balance lower than the ledger",
      txns: [txn("in", 500_000, "2026-03-02T00:00:00Z")],
      actual: 1_200_000,
      tol: 1000,
      expected: { expectedVnd: 1_500_000, differenceVnd: -300_000, exceeds: true },
    },
    {
      name: "missing inflow: balance higher than the ledger",
      txns: [],
      actual: 1_050_000,
      tol: 1000,
      expected: { expectedVnd: 1_000_000, differenceVnd: 50_000, exceeds: true },
    },
    {
      name: "difference equal to the tolerance is accepted",
      txns: [],
      actual: 1_001_000,
      tol: 1000,
      expected: { expectedVnd: 1_000_000, differenceVnd: 1000, exceeds: false },
    },
    {
      name: "one VND over the tolerance",
      txns: [],
      actual: 1_001_001,
      tol: 1000,
      expected: { expectedVnd: 1_000_000, differenceVnd: 1001, exceeds: true },
    },
    {
      name: "negative side one VND over the tolerance",
      txns: [],
      actual: 998_999,
      tol: 1000,
      expected: { expectedVnd: 1_000_000, differenceVnd: -1001, exceeds: true },
    },
    {
      name: "transaction at the previous snapshot time is already inside it",
      txns: [txn("out", 100_000, T0)],
      actual: 1_000_000,
      tol: 0,
      expected: { expectedVnd: 1_000_000, differenceVnd: 0, exceeds: false },
    },
    {
      name: "transaction at the new snapshot time counts",
      txns: [txn("out", 100_000, T1)],
      actual: 900_000,
      tol: 0,
      expected: { expectedVnd: 900_000, differenceVnd: 0, exceeds: false },
    },
    {
      name: "transaction after the new snapshot is ignored",
      txns: [txn("out", 100_000, "2026-03-08T00:00:01Z")],
      actual: 1_000_000,
      tol: 0,
      expected: { expectedVnd: 1_000_000, differenceVnd: 0, exceeds: false },
    },
    {
      name: "other accounts are ignored",
      txns: [txn("out", 100_000, "2026-03-02T00:00:00Z", "other")],
      actual: 1_000_000,
      tol: 0,
      expected: { expectedVnd: 1_000_000, differenceVnd: 0, exceeds: false },
    },
  ];
  it.each(cases)("$name", ({ txns, actual, tol, expected }) => {
    expect(
      evaluateBalance({
        bankAccountId: "acc",
        previous,
        actual: { balanceVnd: actual, takenAt: T1 },
        transactions: txns,
        toleranceVnd: tol,
      }),
    ).toEqual(expected);
  });
});

async function seeded() {
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
  } as unknown as EventEnvelope);
  const record = (await store.find("u1"))!;
  const accountId = record.accounts[0]!.id;
  const published: EventEnvelope[] = [];
  const snapshots = new MemoryBalanceSnapshotStore();
  const check = createBalanceCheck({
    store,
    snapshots,
    publish: (e) => void published.push(e),
    readSettings: async () => ({}),
  });
  return { store, record, accountId, published, check, snapshots };
}

describe("weekly balance check", () => {
  it("emits balance.discrepancy_found with the difference when the balance differs from the ledger", async () => {
    const { record, accountId, published, check } = await seeded();
    await check.run("u1", [{ bankAccountId: accountId, balanceVnd: 1_000_000, takenAt: T0 }], NOW);
    expect(published).toHaveLength(0);
    record.transactions.push(
      txn("out", 200_000, "2026-03-03T00:00:00Z", accountId) as unknown as TransactionRecord,
    );
    const result = await check.run(
      "u1",
      [{ bankAccountId: accountId, balanceVnd: 600_000, takenAt: T1 }],
      NOW,
    );
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      type: "balance.discrepancy_found",
      userId: "u1",
      payload: {
        bankAccountId: accountId,
        expectedVnd: 800_000,
        actualVnd: 600_000,
        differenceVnd: -200_000,
      },
    });
    expect(result.discrepancies).toBe(1);
  });

  it("the first snapshot is a baseline and emits nothing", async () => {
    const { accountId, published, check } = await seeded();
    await check.run("u1", [{ bankAccountId: accountId, balanceVnd: 5, takenAt: T0 }], NOW);
    expect(published).toHaveLength(0);
  });

  it("emits nothing within the tolerance", async () => {
    const { accountId, published, check } = await seeded();
    await check.run("u1", [{ bankAccountId: accountId, balanceVnd: 1000, takenAt: T0 }], NOW);
    await check.run("u1", [{ bankAccountId: accountId, balanceVnd: 2000, takenAt: T1 }], NOW);
    expect(published).toHaveLength(0);
  });

  it("a repeated submission of the same snapshot emits once", async () => {
    const { accountId, published, check } = await seeded();
    await check.run("u1", [{ bankAccountId: accountId, balanceVnd: 0, takenAt: T0 }], NOW);
    const second = [{ bankAccountId: accountId, balanceVnd: 50_000, takenAt: T1 }];
    await check.run("u1", second, NOW);
    await check.run("u1", second, NOW);
    expect(published).toHaveLength(1);
  });

  it("ignores an unknown account and a snapshot older than the last one", async () => {
    const { accountId, published, check } = await seeded();
    await check.run("u1", [{ bankAccountId: accountId, balanceVnd: 0, takenAt: T1 }], NOW);
    await check.run("u1", [{ bankAccountId: accountId, balanceVnd: 9_999_999, takenAt: T0 }], NOW);
    await check.run("u1", [{ bankAccountId: "nope", balanceVnd: 1, takenAt: T1 }], NOW);
    expect(published).toHaveLength(0);
  });

  it("uses the tolerance setting", async () => {
    const { store, accountId, published, snapshots } = await seeded();
    const check = createBalanceCheck({
      store,
      snapshots,
      publish: (e) => void published.push(e),
      readSettings: async () => ({ "budget.balance_tolerance_vnd": 100_000 }),
    });
    await check.run("u1", [{ bankAccountId: accountId, balanceVnd: 0, takenAt: T0 }], NOW);
    await check.run("u1", [{ bankAccountId: accountId, balanceVnd: 100_000, takenAt: T1 }], NOW);
    expect(published).toHaveLength(0);
    await check.run(
      "u1",
      [{ bankAccountId: accountId, balanceVnd: 300_001, takenAt: "2026-03-15T00:00:00.000Z" }],
      NOW,
    );
    expect(published).toHaveLength(1);
  });
});

describe("POST /budget/balance-snapshots", () => {
  it("runs the check and emits the discrepancy", async () => {
    const { createApp } = await import("../src/index");
    const { loadConfig } = await import("@my-wife/config");
    const { store, accountId } = await seeded();
    const published: EventEnvelope[] = [];
    const app = createApp(loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" }), {
      store,
      now: () => NOW,
      publish: (e) => void published.push(e),
    });
    const post = (body: unknown, headers: Record<string, string> = { "x-user-id": "u1" }) =>
      app.inject({
        method: "POST",
        url: "/budget/balance-snapshots",
        headers,
        payload: body as object,
      });
    expect((await post({}, {})).statusCode).toBe(401);
    expect((await post({ bankAccountId: accountId })).statusCode).toBe(400);
    await post({ bankAccountId: accountId, balanceVnd: 1_000_000, takenAt: T0 });
    const res = await post({ bankAccountId: accountId, balanceVnd: 400_000, takenAt: T1 });
    expect(res.statusCode).toBe(200);
    expect(published.map((e) => e.type)).toEqual(["balance.discrepancy_found"]);
    await app.close();
  });
});
