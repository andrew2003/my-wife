import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { BudgetOverviewResponseSchema, type EventEnvelope } from "@my-wife/contracts";
import { createApp } from "../src/index";
import { createOnboardingHandler, MemorySampleBudgetStore } from "../src/onboarding";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const NOW = new Date("2026-03-05T10:00:00Z");
const headers = { "x-user-id": "u1" };

async function onboarded() {
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
  return store;
}

describe("GET /budget/overview", () => {
  it("requires the gateway user id", async () => {
    const app = await createApp(config);
    const res = await app.inject({ method: "GET", url: "/budget/overview" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 404 when the user has no cycle", async () => {
    const app = await createApp(config);
    const res = await app.inject({ method: "GET", url: "/budget/overview", headers });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ ok: false, error: { code: "budget.cycle_not_found" } });
  });

  it("returns the documented shape with the spending of the current week", async () => {
    const store = await onboarded();
    const record = store.get("u1")!;
    // The cycle starts on 2026-03-02; NOW is in its first week.
    record.cycle.firstDay = "2026-03-02";
    record.cycle.state = "running";
    const category = record.categories.find((c) => c.kind === "variable" && c.cycleLimitVnd > 0)!;
    const base = {
      cycleId: record.cycle.id,
      bankAccountId: category.bankAccountId,
      direction: "out" as const,
      memo: "m",
      counterparty: null,
      transactionType: "coded_unplanned" as const,
      reconciliationResult: "unplanned" as const,
      announced: true,
    };
    record.transactions.push(
      {
        ...base,
        id: "t-this-week",
        receiptId: "r1",
        bankTransactionRef: "b1",
        amountVnd: 50_000,
        occurredAt: "2026-03-04T05:00:00.000Z",
        categoryId: category.id,
      },
      {
        ...base,
        id: "t-other-week",
        receiptId: "r2",
        bankTransactionRef: "b2",
        amountVnd: 70_000,
        occurredAt: "2026-03-10T05:00:00.000Z",
        categoryId: category.id,
      },
    );
    const anomaly = {
      kind: "unknown_receipt" as const,
      cycleId: record.cycle.id,
      questionId: "q1",
      expiresAt: "2026-03-06T00:00:00.000Z",
      receipt: {} as never,
      resolvedCategoryId: null,
      transactionId: null,
      openedAnnounced: true,
    };
    record.anomalies.push(
      { ...anomaly, id: "a1", receiptId: "r9", state: "open", resolvedAnnounced: false },
      { ...anomaly, id: "a2", receiptId: "r8", state: "resolved", resolvedAnnounced: true },
    );

    const app = await createApp(config, { store, now: () => NOW });
    const res = await app.inject({ method: "GET", url: "/budget/overview", headers });
    expect(res.statusCode).toBe(200);
    const parsed = BudgetOverviewResponseSchema.parse(res.json());
    if (!parsed.ok) throw new Error("expected ok");
    const data = parsed.data;
    expect(data.weekIndex).toBe(1);
    expect(data.cycle.id).toBe(record.cycle.id);
    expect(data.bankAccounts).toHaveLength(record.accounts.length);
    expect(data.categories).toHaveLength(record.categories.length);
    const row = data.categories.find((c) => c.category.id === category.id)!;
    expect(row.spentVnd).toBe(50_000);
    expect(row.remainingVnd).toBe(row.weeklyLimitVnd - 50_000);
    expect(data.transactions.map((t) => t.id).sort()).toEqual(["t-other-week", "t-this-week"]);
    expect(data.transactions.find((t) => t.id === "t-other-week")!.weekIndex).toBe(2);
    expect(data.anomalies).toEqual([
      { id: "a1", kind: "unknown_receipt", subjectRef: "receipt:r9" },
    ]);
  });

  it("clamps the week index to the cycle", async () => {
    const store = await onboarded();
    const record = store.get("u1")!;
    record.cycle.firstDay = "2025-01-06";
    record.cycle.state = "closing";
    const app = await createApp(config, { store, now: () => NOW });
    const res = await app.inject({ method: "GET", url: "/budget/overview", headers });
    expect(res.json().data.weekIndex).toBe(record.cycle.weeks);
  });
});
