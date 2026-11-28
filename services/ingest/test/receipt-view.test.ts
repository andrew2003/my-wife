import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { createApp } from "../src/index";
import { MemoryIngestStore, type ReceiptRecord } from "../src/store";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });

const parsed: ReceiptRecord = {
  id: "rcpt-1",
  userId: "user-1",
  state: "parsed",
  messageId: null,
  sender: "bank@example.test",
  sizeBytes: 100,
  receivedAt: "2026-11-26T04:00:00.000Z",
  dkimResult: "pass",
  source: "parser",
  templateId: "tpl-1",
  templateVersion: 1,
  fields: {
    bankTransactionRef: "FT1",
    bankAccountHint: "1234",
    direction: "out",
    amountVnd: 50000,
    currency: "VND",
    counterparty: null,
    memo: "lunch",
    occurredAt: "2026-11-26T03:00:00.000Z",
  },
};

async function setup() {
  const store = new MemoryIngestStore();
  await store.save(parsed);
  await store.save({
    id: "rcpt-2",
    userId: "user-1",
    state: "rejected",
    dkimResult: "fail",
  } as ReceiptRecord);
  return createApp(config, {
    ingest: {
      secret: "s",
      store,
      verifyDkim: async () => ({ result: "none" }) as never,
      users: { resolve: async () => null },
      senderMap: [],
      templates: [],
      publish: async () => {},
      settings: { maxEmailBytes: 1048576, holdMatchWindowHours: 72 },
      now: () => new Date("2026-11-26T04:00:00.000Z"),
    },
  });
}

const get = (app: Awaited<ReturnType<typeof setup>>, id: string, user?: string) =>
  app.inject({ method: "GET", url: `/receipts/${id}`, headers: user ? { "x-user-id": user } : {} });

describe("GET /receipts/:receiptId", () => {
  it("answers 401 without a user header", async () => {
    expect((await get(await setup(), "rcpt-1")).statusCode).toBe(401);
  });

  it("returns the state and normalized fields of the user's own receipt", async () => {
    const res = await get(await setup(), "rcpt-1", "user-1");
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.state).toBe("parsed");
    expect(data.receipt).toMatchObject({
      receiptId: "rcpt-1",
      bankTransactionRef: "FT1",
      amountVnd: 50000,
      direction: "out",
      source: "parser",
      fxProvisional: false,
    });
  });

  it("answers 404 for another user's receipt, an unknown id and a receipt without fields", async () => {
    const app = await setup();
    expect((await get(app, "rcpt-1", "user-2")).statusCode).toBe(404);
    expect((await get(app, "nope", "user-1")).statusCode).toBe(404);
    expect((await get(app, "rcpt-2", "user-1")).statusCode).toBe(404);
  });
});
