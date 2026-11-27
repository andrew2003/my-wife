import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import type { EventEnvelope } from "@my-wife/contracts";
import { createApp } from "../src/index";
import { parseTlv } from "../src/transfer-qr";
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

type Row = { bankAccountId: string; requiredVnd: number; memo: string; qrPayload?: string };

describe("GET /budget/funding transfer QR", () => {
  it("encodes account, amount and transfer code when the destination is known", async () => {
    const { store } = await awaitingFunds();
    const app = await createApp(config, {
      store,
      now: () => NOW,
      readBankDestination: async (_userId, bankAccountId) =>
        bankAccountId.endsWith("1")
          ? undefined
          : { bankBin: "970436", accountNumber: "0011001234" },
    });
    const res = await app.inject({ method: "GET", url: "/budget/funding", headers });
    const rows = res.json().data.accounts as Row[];
    const withQr = rows.filter((r) => r.qrPayload !== undefined);
    expect(withQr.length).toBeGreaterThan(0);
    for (const row of withQr) {
      const tags = parseTlv(row.qrPayload!);
      expect(tags["54"]).toBe(String(row.requiredVnd));
      expect(parseTlv(tags["62"]!)["08"]).toBe(row.memo);
      expect(parseTlv(parseTlv(tags["38"]!)["01"]!)["01"]).toBe("0011001234");
    }
  });

  it("omits the QR when no destination resolver is wired", async () => {
    const { store } = await awaitingFunds();
    const app = await createApp(config, { store, now: () => NOW });
    const res = await app.inject({ method: "GET", url: "/budget/funding", headers });
    for (const row of res.json().data.accounts as Row[]) expect(row.qrPayload).toBeUndefined();
  });
});
