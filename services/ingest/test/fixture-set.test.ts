import { beforeEach, describe, expect, it } from "vitest";
import { parseEvent, type EventEnvelope } from "@my-wife/contracts";
import { processInbound, type PipelineDeps } from "../src/pipeline";
import { MemoryIngestStore } from "../src/store";
import { createMailauthVerifier } from "../src/dkim";
import { BANK_ADDRESS, BANK_DOMAIN, testResolver } from "./fixtures";
import { buildFixtureMail, FIXTURE_NAMES, fixtureTemplates, type FixtureName } from "./fixture-set";

const NOW = new Date("2026-11-26T04:00:00.000Z");
const TO = "u-tok123@in.example.test";

let events: EventEnvelope[];
let deps: PipelineDeps;
let seq = 0;

beforeEach(() => {
  events = [];
  seq = 0;
  deps = {
    store: new MemoryIngestStore(),
    verifyDkim: createMailauthVerifier(testResolver),
    users: { resolve: async (t) => ({ userId: `user-${t}`, emailConsent: true }) },
    senderMap: [{ senderKey: "bank", senderAddress: BANK_ADDRESS, dkimDomain: BANK_DOMAIN }],
    templates: fixtureTemplates(),
    publish: async (e) => {
      const parsed = parseEvent(e);
      if (!parsed.success) throw new Error(parsed.error);
      events.push(parsed.data);
    },
    newId: () => `id-${++seq}`,
    settings: { maxEmailBytes: 1048576, holdMatchWindowHours: 72 },
  };
});

const send = async (name: FixtureName) =>
  processInbound({ toAddress: TO, raw: await buildFixtureMail(name) }, deps, NOW);
const types = () => events.map((e) => e.type);

describe("synthetic fixture set", () => {
  it("covers every case the spec lists", () => {
    expect([...FIXTURE_NAMES].sort()).toEqual(
      [
        "credit",
        "debit",
        "duplicate",
        "fee",
        "forgedDkim",
        "foreignAuthorization",
        "foreignDebit",
        "injection",
        "layoutChange",
        "qrDefaultMemo",
      ].sort(),
    );
  });

  it("debit: parsed once with the verbatim facts", async () => {
    expect(await send("debit")).toMatchObject({ state: "parsed" });
    expect(types()).toEqual(["receipt.parsed"]);
    expect(events[0]?.payload).toMatchObject({
      amountVnd: 150000,
      direction: "out",
      bankTransactionRef: "FT26330ABC123",
      balanceAfterVnd: 2350000,
      source: "parser",
    });
  });

  it("QR default memo: the memo is the bank default and no category is decided", async () => {
    expect(await send("qrDefaultMemo")).toMatchObject({ state: "parsed" });
    expect(types()).toEqual(["receipt.parsed"]);
    const payload = events[0]?.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      amountVnd: 45000,
      direction: "out",
      memo: "QR Payment",
      bankTransactionRef: "FT26330QR0001",
    });
    expect(payload).not.toHaveProperty("categoryId");
    expect(payload).not.toHaveProperty("transactionType");
  });

  it("credit: an incoming amount", async () => {
    expect(await send("credit")).toMatchObject({ state: "parsed" });
    expect(events[0]?.payload).toMatchObject({
      amountVnd: 2000000,
      direction: "in",
      bankTransactionRef: "FT26330CRD001",
    });
  });

  it("foreign card pair: the authorization is held, the debit emits once with the VND amount", async () => {
    expect(await send("foreignAuthorization")).toMatchObject({ state: "parsing" });
    expect(types()).toEqual([]);
    expect(await send("foreignDebit")).toMatchObject({ state: "parsed" });
    expect(types()).toEqual(["receipt.parsed"]);
    expect(events[0]?.payload).toMatchObject({
      amountVnd: 250000,
      currency: "USD",
      foreignAmountMinor: 999,
      fxProvisional: false,
    });
  });

  it("fee: an outgoing amount with the bank fee memo; type is left to budget", async () => {
    expect(await send("fee")).toMatchObject({ state: "parsed" });
    const payload = events[0]?.payload as Record<string, unknown>;
    expect(payload).toMatchObject({ amountVnd: 11000, direction: "out", memo: "SMS banking fee" });
    expect(payload).not.toHaveProperty("transactionType");
  });

  it("forged DKIM: rejected with dkim_invalid and nothing is booked", async () => {
    expect(await send("forgedDkim")).toMatchObject({
      state: "rejected",
      reason: "dkim_invalid",
    });
    expect(types()).toEqual(["receipt.rejected"]);
  });

  it("duplicate: the second delivery is duplicate and emits nothing", async () => {
    expect(await send("debit")).toMatchObject({ state: "parsed" });
    expect(await send("duplicate")).toMatchObject({ state: "duplicate" });
    expect(types()).toEqual(["receipt.parsed"]);
  });

  it("layout change: the trusted parser is not used, the mail waits for the user", async () => {
    expect(await send("layoutChange")).toMatchObject({ state: "needs_confirmation" });
    expect(types()).toEqual(["receipt.unknown"]);
    expect(JSON.stringify(events)).not.toMatch(/amountVnd/);
  });

  it("injection: only structured fields are stored", async () => {
    expect(await send("injection")).toMatchObject({ state: "parsed" });
    expect(types()).toEqual(["receipt.parsed"]);
    expect(events[0]?.payload).toMatchObject({ amountVnd: 150000, direction: "out" });
  });
});
