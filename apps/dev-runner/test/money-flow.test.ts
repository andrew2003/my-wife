import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import type { EventEnvelope } from "@my-wife/contracts";
import {
  BASIC_BANK_TEMPLATE,
  FOREIGN_CARD_TEMPLATE,
  MemoryIngestStore,
  createMailauthVerifier,
  fingerprintOfMail,
  type RegisteredTemplate,
} from "@my-wife/ingest";
import {
  BANK_DKIM_DOMAIN,
  BANK_SENDER,
  buildEmailFixtures,
  createDkimKey,
  dkimDnsResolver,
  injectEmails,
  type EmailFixture,
} from "@my-wife/test-kit";
import { startAll, type Runner } from "../src/runner";

const SECRET = "ingest-secret-for-tests";
const USER = "0190a0a0-0000-7000-8000-0000000000f1";
const TOKEN = "demo";
const NOW = new Date("2026-11-26T03:00:00.000Z");
const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const CYCLE = "22222222-2222-4222-8222-222222222222";

let runner: Runner | undefined;
let events: EventEnvelope[];
let delivered: string[];
let fixtures: Record<string, EmailFixture>;
let templates: RegisteredTemplate[];
let bankKey: ReturnType<typeof createDkimKey>;

async function start(extra: { passAllDkim?: boolean } = {}) {
  runner = await startAll(config, {
    ephemeralPorts: true,
    onEvent: (e) => void events.push(e),
    onDelivered: (service, e) => void delivered.push(`${service}:${e.type}`),
    ingest: {
      secret: SECRET,
      store: new MemoryIngestStore(),
      verifyDkim: extra.passAllDkim
        ? async () => ({ result: "pass", domain: BANK_DKIM_DOMAIN })
        : createMailauthVerifier(
            dkimDnsResolver([
              { domain: BANK_DKIM_DOMAIN, selector: bankKey.selector, key: bankKey },
            ]),
          ),
      senderMap: [{ senderKey: "bank", senderAddress: BANK_SENDER, dkimDomain: BANK_DKIM_DOMAIN }],
      templates,
      users: {
        resolve: async (t) => (t === TOKEN ? { userId: USER, emailConsent: true } : null),
      },
    },
  });
}

beforeEach(async () => {
  events = [];
  delivered = [];
  bankKey = createDkimKey();
  const all = await buildEmailFixtures({
    bankKey,
    attackerKey: createDkimKey(),
    now: NOW,
    toAddress: `u-${TOKEN}@in.example.test`,
  });
  fixtures = Object.fromEntries(all.map((f) => [f.name, f]));
  // Register the layouts of the mails expected to parse; "fee" stays unregistered.
  templates = [];
  for (const [name, parser] of [
    ["debit", BASIC_BANK_TEMPLATE],
    ["credit", BASIC_BANK_TEMPLATE],
    ["foreign-card-authorization", FOREIGN_CARD_TEMPLATE],
    ["foreign-card-debit", FOREIGN_CARD_TEMPLATE],
  ] as const) {
    const fingerprint = await fingerprintOfMail(Buffer.from(fixtures[name]!.raw));
    templates.push({ ...parser, senderKey: "bank", fingerprint });
  }
});

afterEach(async () => {
  await runner?.stop();
  runner = undefined;
});

const send = async (...only: string[]) =>
  injectEmails(Object.values(fixtures), {
    url: `${runner!.urls.ingest}/webhook/inbound-email`,
    secret: SECRET,
    only,
  });
const types = () => events.map((e) => e.type);

describe("money flow in the dev runner", () => {
  it("mounts the ingest webhook and publishes receipt.parsed for a parseable mail", async () => {
    await start();
    const [res] = await send("debit");
    expect(res).toMatchObject({ status: 200, body: { ok: true, data: { state: "parsed" } } });
    expect(types()).toEqual(["receipt.parsed"]);
    expect(events[0]).toMatchObject({
      userId: USER,
      payload: { amountVnd: 1_250_000, direction: "out", bankTransactionRef: "FT26306000001" },
    });
  });

  it("rejects a forged mail and a wrong secret", async () => {
    await start();
    const [forged] = await send("forged-dkim");
    expect(forged?.status).toBe(422);
    const res = await fetch(`${runner!.urls.ingest}/webhook/inbound-email`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ingest-secret": "nope" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    expect(types()).toEqual(["receipt.rejected"]);
  });

  it("an unregistered layout becomes receipt.unknown and reaches budget", async () => {
    await start();
    const [res] = await send("fee");
    expect(res).toMatchObject({ status: 200, body: { data: { state: "needs_confirmation" } } });
    expect(types()).toEqual(["receipt.unknown"]);
    expect(delivered).toContain("budget:receipt.unknown");
  });

  it("routes receipt.parsed to budget and rules", async () => {
    await start();
    await send("credit");
    expect(delivered).toEqual(
      expect.arrayContaining(["budget:receipt.parsed", "rules:receipt.parsed"]),
    );
  });

  it("routes contract.signed, week.closed and overspend.detected; rules starts the trial and suspends the penalty", async () => {
    await start();
    const base = { userId: USER, occurredAt: NOW.toISOString(), schemaVersion: 1 };
    await runner!.publish({
      ...base,
      id: "e1",
      type: "contract.signed",
      payload: { contractId: "33333333-3333-4333-8333-333333333333", cycleId: CYCLE, version: 1 },
    } as EventEnvelope);
    await runner!.publish({
      ...base,
      id: "e2",
      type: "week.closed",
      payload: {
        weekId: "44444444-4444-4444-8444-444444444444",
        firstDay: "2026-11-23",
        weekIndexInCycle: 1,
      },
    } as EventEnvelope);
    await runner!.publish({
      ...base,
      id: "e3",
      type: "overspend.detected",
      payload: {
        cycleId: CYCLE,
        weekIndex: 2,
        categoryId: "55555555-5555-4555-8555-555555555555",
        priority: "want",
        weeklyLimitVnd: 200_000,
        spentVnd: 250_000,
        excessVnd: 50_000,
      },
    } as EventEnvelope);
    expect(delivered).toEqual(
      expect.arrayContaining([
        "budget:contract.signed",
        "rules:contract.signed",
        "budget:week.closed",
        "rules:overspend.detected",
      ]),
    );
    expect(types()).toEqual(expect.arrayContaining(["trial.started", "penalty.suspended"]));
  });
});
