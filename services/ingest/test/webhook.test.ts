import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { createApp } from "../src/index";
import { MemoryIngestStore } from "../src/store";
import { createMailauthVerifier } from "../src/dkim";
import { BASIC_BANK_TEMPLATE, fingerprintTemplate } from "../src/templates";
import {
  BANK_ADDRESS,
  BANK_DOMAIN,
  buildMail,
  DEBIT_BODY,
  SUBJECT,
  testResolver,
  type MailOptions,
} from "./fixtures";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const SECRET = "test-ingest-secret";

async function setup() {
  const store = new MemoryIngestStore();
  const published: string[] = [];
  const app = await createApp(config, {
    ingest: {
      secret: SECRET,
      store,
      verifyDkim: createMailauthVerifier(testResolver),
      users: { resolve: async () => ({ userId: "user-1", emailConsent: true }) },
      senderMap: [{ senderKey: "bank", senderAddress: BANK_ADDRESS, dkimDomain: BANK_DOMAIN }],
      templates: [
        {
          ...BASIC_BANK_TEMPLATE,
          senderKey: "bank",
          fingerprint: fingerprintTemplate({
            sender: BANK_ADDRESS,
            subject: SUBJECT,
            body: DEBIT_BODY,
          }),
        },
      ],
      publish: async (e) => {
        published.push(e.type);
      },
      settings: { maxEmailBytes: 1048576, holdMatchWindowHours: 72 },
      now: () => new Date("2026-11-26T04:00:00.000Z"),
    },
  });
  return { app, store, published };
}

const payload = async (opts: MailOptions = {}) => {
  const raw = await buildMail(opts);
  return {
    toAddress: "u-tok123@in.example.test",
    rawBase64: raw.toString("base64"),
    sizeBytes: raw.length,
  };
};

describe("POST /webhook/inbound-email", () => {
  it.each([[undefined], ["wrong"]])(
    "returns 401 and stores nothing with secret %s",
    async (secret) => {
      const { app, store, published } = await setup();
      const res = await app.inject({
        method: "POST",
        url: "/webhook/inbound-email",
        headers: secret ? { "x-ingest-secret": secret } : {},
        payload: await payload(),
      });
      expect(res.statusCode).toBe(401);
      expect(store.size()).toBe(0);
      expect(published).toEqual([]);
    },
  );

  it("accepts a mail with the right secret", async () => {
    const { app, published } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/webhook/inbound-email",
      headers: { "x-ingest-secret": SECRET },
      payload: await payload(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, data: { state: "parsed" } });
    expect(published).toEqual(["receipt.parsed"]);
  });

  it("answers an unsigned mail with dkim_invalid", async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/webhook/inbound-email",
      headers: { "x-ingest-secret": SECRET },
      payload: await payload({ sign: "none" }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ ok: false, error: { code: "dkim_invalid" } });
  });

  it.each([
    ["upper case", "U-tok123@IN.EXAMPLE.TEST"],
    ["angle brackets", "<u-tok123@in.example.test>"],
    ["display name", "My Wife <u-tok123@in.example.test>"],
    ["surrounding spaces", "  u-tok123@in.example.test \n"],
  ])("accepts a Cloudflare recipient with %s", async (_n, toAddress) => {
    const { app, published } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/webhook/inbound-email",
      headers: { "x-ingest-secret": SECRET },
      payload: { ...(await payload()), toAddress },
    });
    expect(res.statusCode).toBe(200);
    expect(published).toEqual(["receipt.parsed"]);
  });

  it("rejects a declared size over the limit before decoding", async () => {
    const { app, store, published } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/webhook/inbound-email",
      headers: { "x-ingest-secret": SECRET },
      payload: { ...(await payload()), sizeBytes: 1048577 },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ ok: false, error: { code: "too_large" } });
    expect(store.size()).toBe(0);
    expect(published).toEqual(["receipt.rejected"]);
  });

  it("still answers unknown_address for an oversize declared size", async () => {
    const { app, published } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/webhook/inbound-email",
      headers: { "x-ingest-secret": SECRET },
      payload: { ...(await payload()), toAddress: "nobody@in.example.test", sizeBytes: 1048577 },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "unknown_address" } });
    expect(published).toEqual([]);
  });

  it("never echoes the shared secret in a response", async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/webhook/inbound-email",
      headers: { "x-ingest-secret": "wrong" },
      payload: await payload(),
    });
    expect(res.body).not.toContain(SECRET);
    expect(res.body).not.toContain("wrong");
  });

  it("rejects an invalid body", async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/webhook/inbound-email",
      headers: { "x-ingest-secret": SECRET },
      payload: { toAddress: "" },
    });
    expect(res.statusCode).toBe(400);
  });
});
