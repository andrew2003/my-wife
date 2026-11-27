import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { createApp } from "../src/index";
import { MemoryIngestStore } from "../src/store";
import { createMailauthVerifier } from "../src/dkim";
import {
  BANK_ADDRESS,
  BANK_DOMAIN,
  buildMail,
  SUBJECT,
  testResolver,
} from "./fixtures";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const SECRET = "test-ingest-secret";

async function setup() {
  const store = new MemoryIngestStore();
  let n = 0;
  const app = await createApp(config, {
    ingest: {
      secret: SECRET,
      store,
      verifyDkim: createMailauthVerifier(testResolver),
      users: { resolve: async () => ({ userId: "user-1", emailConsent: true }) },
      senderMap: [{ senderKey: "bank", senderAddress: BANK_ADDRESS, dkimDomain: BANK_DOMAIN }],
      // No template is registered, so the mail waits for confirmation (unknown layout).
      templates: [],
      publish: async () => {},
      newId: () => `id-${++n}`,
      settings: { maxEmailBytes: 1048576, holdMatchWindowHours: 72 },
      now: () => new Date("2026-11-26T04:00:00.000Z"),
    },
  });
  const raw = await buildMail();
  const res = await app.inject({
    method: "POST",
    url: "/webhook/inbound-email",
    headers: { "x-ingest-secret": SECRET },
    payload: {
      toAddress: "u-tok123@in.example.test",
      rawBase64: raw.toString("base64"),
      sizeBytes: raw.length,
    },
  });
  const receiptId = res.json().data.receiptId as string;
  return { app, store, receiptId };
}

const get = (app: Awaited<ReturnType<typeof setup>>["app"], id: string, user?: string) =>
  app.inject({
    method: "GET",
    url: `/receipts/${id}/raw-email`,
    headers: user ? { "x-user-id": user } : {},
  });

describe("GET /receipts/:receiptId/raw-email", () => {
  it("returns sender, subject and body to the owner", async () => {
    const { app, receiptId } = await setup();
    const res = await get(app, receiptId, "user-1");
    expect(res.statusCode).toBe(200);
    const { ok, data } = res.json();
    expect(ok).toBe(true);
    expect(data.sender).toBe(BANK_ADDRESS);
    expect(data.subject).toBe(SUBJECT);
    expect(data.body).toContain("Ref: FT26330ABC123");
  });

  it("answers 401 without the user header", async () => {
    const { app, receiptId } = await setup();
    expect((await get(app, receiptId)).statusCode).toBe(401);
  });

  it("answers 404 for another user's receipt and leaks nothing", async () => {
    const { app, receiptId } = await setup();
    const res = await get(app, receiptId, "user-2");
    expect(res.statusCode).toBe(404);
    expect(JSON.stringify(res.json())).not.toContain(SUBJECT);
  });

  it("answers 404 for an unknown receipt", async () => {
    const { app } = await setup();
    expect((await get(app, "nope", "user-1")).statusCode).toBe(404);
  });
});
