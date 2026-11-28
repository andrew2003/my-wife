import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import type { EventEnvelope } from "@my-wife/contracts";
import { createApp } from "../src/index";
import { createReceiptHandler } from "../src/accounts";
import { createContractSignedHandler, createCycleApprover } from "../src/approval";
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

async function awaitingFunds() {
  const store = await onboarded();
  const record = store.get("u1")!;
  await createContractSignedHandler({ store })({
    id: "s1",
    type: "contract.signed",
    occurredAt: NOW.toISOString(),
    userId: "u1",
    schemaVersion: 1,
    payload: { contractId: "c1", cycleId: record.cycle.id, version: 1 },
  } as EventEnvelope);
  const confirm = createReceiptHandler({ store, now: () => NOW });
  for (const a of record.accounts) {
    await confirm({
      id: `x-${a.code}`,
      type: "receipt.parsed",
      occurredAt: NOW.toISOString(),
      userId: "u1",
      schemaVersion: 1,
      payload: {
        receiptId: `r-${a.code}`,
        bankTransactionRef: a.code,
        bankAccountHint: a.code,
        direction: "in",
        amountVnd: 1000,
        currency: "VND",
        counterparty: null,
        memo: "",
        occurredAt: NOW.toISOString(),
        source: "email",
        fxProvisional: false,
      },
    } as unknown as EventEnvelope);
  }
  const requests: EventEnvelope[] = [];
  await createCycleApprover({ store, now: () => NOW, publish: (e) => void requests.push(e) })({
    userId: "u1",
    cycleId: record.cycle.id,
    commitmentId: "c1",
  });
  const transfers = (requests[0] as EventEnvelope<"cycle.funds_requested">).payload.transfers;
  return { store, record, transfers };
}

type Row = { bankAccountId: string; funded: boolean };

describe("GET /budget/funding", () => {
  it("requires the gateway user id", async () => {
    const app = await createApp(config);
    const res = await app.inject({ method: "GET", url: "/budget/funding" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 404 when there is no cycle", async () => {
    const app = await createApp(config);
    const res = await app.inject({ method: "GET", url: "/budget/funding", headers });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ ok: false, error: { code: "budget.cycle_not_found" } });
  });

  it("returns 409 while the cycle is still a draft", async () => {
    const store = await onboarded();
    const app = await createApp(config, { store });
    const res = await app.inject({ method: "GET", url: "/budget/funding", headers });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      ok: false,
      error: { code: "budget.cycle_not_awaiting_funds" },
    });
  });

  it("lists every transfer with its amount, memo and funded flag", async () => {
    const { store, record, transfers } = await awaitingFunds();
    const paid = transfers.find((t) => t.requiredVnd > 0)!;
    await store.recordFunding(
      "u1",
      record.cycle.id,
      {
        bankAccountId: paid.bankAccountId,
        bankTransactionRef: "ref1",
        receiptId: "r1",
        amountVnd: paid.requiredVnd,
      },
      NOW,
    );
    const app = await createApp(config, { store });
    const res = await app.inject({ method: "GET", url: "/budget/funding", headers });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.cycle.id).toBe(record.cycle.id);
    expect(body.data.accounts).toHaveLength(transfers.length);
    for (const t of transfers) {
      const account = record.accounts.find((a) => a.id === t.bankAccountId)!;
      const row = body.data.accounts.find((a: Row) => a.bankAccountId === t.bankAccountId);
      expect(row).toEqual({
        bankAccountId: t.bankAccountId,
        name: account.name,
        code: account.code,
        requiredVnd: t.requiredVnd,
        memo: t.memo,
        funded: t.requiredVnd === 0 || t.bankAccountId === paid.bankAccountId,
      });
    }
  });

  it.each(["running", "closing", "closed"] as const)(
    "still lists the transfers for a %s cycle",
    async (state) => {
      const { store, record } = await awaitingFunds();
      record.cycle.state = state;
      const app = await createApp(config, { store });
      const res = await app.inject({ method: "GET", url: "/budget/funding", headers });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.cycle.state).toBe(state);
    },
  );

  it("does not count a short payment as funded", async () => {
    const { store, record, transfers } = await awaitingFunds();
    const paid = transfers.find((t) => t.requiredVnd > 1)!;
    await store.recordFunding(
      "u1",
      record.cycle.id,
      {
        bankAccountId: paid.bankAccountId,
        bankTransactionRef: "ref1",
        receiptId: "r1",
        amountVnd: paid.requiredVnd - 1,
      },
      NOW,
    );
    const app = await createApp(config, { store });
    const res = await app.inject({ method: "GET", url: "/budget/funding", headers });
    const row = res.json().data.accounts.find((a: Row) => a.bankAccountId === paid.bankAccountId);
    expect(row.funded).toBe(false);
  });
});
