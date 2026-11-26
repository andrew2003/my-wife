import { beforeEach, describe, expect, it } from "vitest";
import { parseEvent, type EventEnvelope } from "@my-wife/contracts";
import { processInbound, type PipelineDeps } from "../src/pipeline";
import { MemoryIngestStore } from "../src/store";
import { createMailauthVerifier } from "../src/dkim";
import {
  FOREIGN_CARD_TEMPLATE,
  fingerprintTemplate,
  parseForeignAmount,
  type RegisteredTemplate,
} from "../src/templates";
import {
  authorizationBody,
  BANK_ADDRESS,
  BANK_DOMAIN,
  buildMail,
  foreignDebitBody,
  testResolver,
} from "./fixtures";

const NOW = new Date("2026-11-26T04:00:00.000Z");
const TO = "u-tok123@in.example.test";
const AUTH_SUBJECT = "Card authorization notice";
const DEBIT_SUBJECT = "Card debit notice";

const reg = (subject: string, body: string): RegisteredTemplate => ({
  ...FOREIGN_CARD_TEMPLATE,
  senderKey: "bank",
  fingerprint: fingerprintTemplate({ sender: BANK_ADDRESS, subject, body }),
});

let events: EventEnvelope[];
let deps: PipelineDeps;
let seq = 0;
let mid = 0;

beforeEach(() => {
  events = [];
  seq = 0;
  mid = 0;
  deps = {
    store: new MemoryIngestStore(),
    verifyDkim: createMailauthVerifier(testResolver),
    users: { resolve: async (t) => ({ userId: `user-${t}`, emailConsent: true }) },
    senderMap: [{ senderKey: "bank", senderAddress: BANK_ADDRESS, dkimDomain: BANK_DOMAIN }],
    templates: [reg(AUTH_SUBJECT, authorizationBody()), reg(DEBIT_SUBJECT, foreignDebitBody())],
    publish: async (e) => {
      const parsed = parseEvent(e);
      if (!parsed.success) throw new Error(parsed.error);
      events.push(parsed.data);
    },
    newId: () => `id-${++seq}`,
    settings: { maxEmailBytes: 1048576, holdMatchWindowHours: 72 },
  };
});

const send = async (subject: string, body: string, to = TO) =>
  processInbound(
    { toAddress: to, raw: await buildMail({ subject, body, messageId: `m${++mid}@bank.test` }) },
    deps,
    NOW,
  );
const auth = (o?: Parameters<typeof authorizationBody>[0], to = TO) =>
  send(AUTH_SUBJECT, authorizationBody(o), to);
const debit = (o?: Parameters<typeof foreignDebitBody>[0], to = TO) =>
  send(DEBIT_SUBJECT, foreignDebitBody(o), to);
const types = () => events.map((e) => e.type);

describe("foreign-card authorization and debit pair", () => {
  it("emits one receipt.parsed with the VND amount of the debit mail", async () => {
    expect(await auth()).toMatchObject({ state: "parsing" });
    expect(types()).toEqual([]);
    expect(await debit()).toMatchObject({ state: "parsed" });
    expect(types()).toEqual(["receipt.parsed"]);
    expect(events[0]?.payload).toMatchObject({
      amountVnd: 250000,
      direction: "out",
      currency: "USD",
      foreignAmountMinor: 999,
      merchant: "GOOGLE*YouTube",
      bankTransactionRef: "FT26330FX001",
      fxProvisional: false,
      source: "parser",
    });
  });

  it("still emits once when the debit arrives before the authorization", async () => {
    await debit();
    expect(await auth()).toMatchObject({ state: "duplicate" });
    expect(types()).toEqual(["receipt.parsed"]);
  });

  it("books a debit that has no authorization", async () => {
    expect(await debit()).toMatchObject({ state: "parsed" });
    expect(types()).toEqual(["receipt.parsed"]);
    expect(events[0]?.payload).toMatchObject({ amountVnd: 250000 });
  });

  it("holds a lone authorization without emitting or booking anything", async () => {
    expect(await auth()).toMatchObject({ state: "parsing" });
    expect(events).toEqual([]);
  });

  it("treats a redelivered authorization as a duplicate", async () => {
    await auth();
    expect(await auth({ ref: "AU26329XYZ02" })).toMatchObject({ state: "duplicate" });
    await debit();
    expect(types()).toEqual(["receipt.parsed"]);
  });

  it("does not pair a different purchase or another user", async () => {
    await auth({ code: "B99999" });
    await auth({}, "u-other@in.example.test");
    await debit();
    // The unrelated authorizations stay held; the debit stands alone.
    expect(types()).toEqual(["receipt.parsed"]);
    expect(await debit({ code: "B99999", ref: "FT26330FX002" })).toMatchObject({
      state: "parsed",
    });
    expect(types()).toEqual(["receipt.parsed", "receipt.parsed"]);
    expect(await deps.store.findHeldByPairKey("user-tok123", "1234|b99999")).toBeNull();
    expect(await deps.store.findHeldByPairKey("user-other", "1234|a12345")).not.toBeNull();
  });

  it("does not count the same purchase twice when the debit is mailed twice", async () => {
    await auth();
    await debit();
    expect(await debit()).toMatchObject({ state: "duplicate" });
    expect(types()).toEqual(["receipt.parsed"]);
  });

  it("treats a second debit of the same purchase with another reference as a duplicate", async () => {
    await auth();
    await debit();
    expect(await debit({ ref: "FT26330FX009" })).toMatchObject({ state: "duplicate" });
    expect(await debit({ ref: "FT26330FX010" })).toMatchObject({ state: "duplicate" });
    expect(types()).toEqual(["receipt.parsed"]);
  });

  it("does not re-pair when the consumed authorization is the only trace after a crash", async () => {
    await auth();
    await debit();
    // The authorization was consumed before the debit was saved, so it is not held again.
    expect(await deps.store.findHeldByPairKey("user-tok123", "1234|a12345")).toBeNull();
  });

  it("uses the window of each user", async () => {
    deps.users = {
      resolve: async (t) => ({
        userId: `user-${t}`,
        emailConsent: true,
        holdMatchWindowHours: t === "short" ? 1 : 72,
      }),
    };
    const late = { time: "26/11/2026 02:00:00" };
    await auth({}, "u-short@in.example.test");
    await auth({}, TO);
    await debit(late, "u-short@in.example.test");
    await debit(late, TO);
    expect(await deps.store.findHeldByPairKey("user-short", "1234|a12345")).not.toBeNull();
    expect(await deps.store.findHeldByPairKey("user-tok123", "1234|a12345")).toBeNull();
    expect(types()).toEqual(["receipt.parsed", "receipt.parsed"]);
  });

  // Authorization at 25/11/2026 20:00:00 local time (UTC+7).
  it.each([
    {
      name: "inside the default window",
      window: 72,
      debitTime: "28/11/2026 19:59:59",
      paired: true,
    },
    {
      name: "at the edge of the window",
      window: 72,
      debitTime: "28/11/2026 20:00:00",
      paired: true,
    },
    {
      name: "after the default window",
      window: 72,
      debitTime: "28/11/2026 20:00:01",
      paired: false,
    },
    {
      name: "after a shortened window",
      window: 1,
      debitTime: "25/11/2026 21:00:01",
      paired: false,
    },
    {
      name: "inside a shortened window",
      window: 1,
      debitTime: "25/11/2026 21:00:00",
      paired: true,
    },
  ])("pairs by the user window setting: $name", async ({ window, debitTime, paired }) => {
    deps.settings = { maxEmailBytes: 1048576, holdMatchWindowHours: window };
    await auth();
    await debit({ time: debitTime });
    // Either way exactly one receipt.parsed; outside the window the authorization stays held.
    expect(types()).toEqual(["receipt.parsed"]);
    const held = await deps.store.findHeldByPairKey("user-tok123", "1234|a12345");
    expect(held === null).toBe(paired);
  });

  it("does not trust a layout without the foreign amount", async () => {
    const body = foreignDebitBody().replace("Foreign amount: 9.99 USD\r\n", "");
    expect(await send(DEBIT_SUBJECT, body)).toMatchObject({ state: "needs_confirmation" });
    expect(types()).toEqual(["receipt.unknown"]);
  });

  it("fails when the debit VND amount is not a whole VND figure", async () => {
    deps.templates = [reg(DEBIT_SUBJECT, foreignDebitBody({ vnd: "250,000.50" }))];
    expect(await debit({ vnd: "250,000.50" })).toMatchObject({ state: "failed" });
    expect(types()).toEqual(["receipt.failed"]);
  });
});

describe("parseForeignAmount", () => {
  it.each([
    ["9.99 USD", { currency: "USD", minor: 999 }],
    ["1,234.50 USD", { currency: "USD", minor: 123450 }],
    ["0.05 EUR", { currency: "EUR", minor: 5 }],
    ["1,500 JPY", { currency: "JPY", minor: 1500 }],
    ["10 USD", null],
    ["9.999 USD", null],
    ["9.99 usd", null],
    ["9.99", null],
    ["-9.99 USD", null],
    ["", null],
  ])("%s", (text, expected) => {
    expect(parseForeignAmount(text)).toEqual(expected);
  });
});
