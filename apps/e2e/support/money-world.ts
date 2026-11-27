import { randomUUID } from "node:crypto";
import { MemorySampleBudgetStore } from "@my-wife/budget";
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
import { InMemoryPenaltyStore, InMemoryTrialStore, type TrialSettings } from "@my-wife/rules";
import {
  BANK_DKIM_DOMAIN,
  BANK_SENDER,
  buildLabelledEmail,
  createDkimKey,
  dkimDnsResolver,
  injectEmails,
  SimClock,
  type LabelledMail,
} from "@my-wife/test-kit";
// The dev runner exports no package entry point; the scenario mounts it from its sources.
import { mountTrialJob, startAll } from "../../dev-runner/src/runner";

export const MONEY_USER = "0190a0a0-0000-7000-8000-0000000000f1";
export const INGEST_SECRET = "e2e-ingest-secret-e2e-ingest-secret";
const TOKEN = "money";
const TO_ADDRESS = `u-${TOKEN}@in.example.test`;
const HOUR_MS = 3_600_000;

/** What a mail is expected to do, as the unknown-spend flow needs its facts from ingest (#233). */
export type UnknownFacts = {
  bankTransactionRef: string;
  bankAccountHint: string;
  amountVnd: number;
  occurredAt: string;
  memo: string;
};

/**
 * The ten services of the money flow in one process through the dev runner: signed bank mails
 * enter the real ingest webhook and the runner routes every event to its consumers. Time comes
 * from one `SimClock`. Chat is emulated: the answer to a question is published as
 * `notify.reply_received`. Stubs remain only where product code is missing: `readReceipt`
 * (#233) and the budget overview and penalties read routes (#247).
 */
export async function startMoneyWorld(opts: { start: string; trial: TrialSettings }) {
  const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
  const clock = new SimClock(opts.start);
  const now = () => clock.now();
  const events: EventEnvelope[] = [];
  let pendingUnknown: UnknownFacts | undefined;

  const bankKey = createDkimKey("e2e");
  const budgetStore = new MemorySampleBudgetStore();
  const penaltyStore = new InMemoryPenaltyStore();
  const trialStore = new InMemoryTrialStore();

  // Register the layouts of the user's bank mails, fingerprinted from sample mails.
  const at = new Date(opts.start);
  const layouts: [LabelledMail, typeof BASIC_BANK_TEMPLATE][] = [
    [
      {
        kind: "debit",
        id: "s1",
        amountVnd: 1,
        reference: "S0001",
        at,
        accountTail: "1",
        memo: "AN",
      },
      BASIC_BANK_TEMPLATE,
    ],
    [
      {
        kind: "credit",
        id: "s2",
        amountVnd: 1,
        reference: "S0002",
        at,
        accountTail: "1",
        memo: "x",
      },
      BASIC_BANK_TEMPLATE,
    ],
    [
      {
        kind: "card_authorization",
        id: "s3",
        foreignAmount: "9.99 USD",
        reference: "S0003",
        at,
        accountTail: "1",
        authCode: "A1",
        merchant: "M",
      },
      FOREIGN_CARD_TEMPLATE,
    ],
    [
      {
        kind: "card_debit",
        id: "s4",
        amountVnd: 1,
        foreignAmount: "9.99 USD",
        reference: "S0004",
        at,
        accountTail: "1",
        authCode: "A1",
        merchant: "M",
        memo: "AN",
      },
      FOREIGN_CARD_TEMPLATE,
    ],
  ];
  const templates: RegisteredTemplate[] = [];
  for (const [m, parser] of layouts) {
    const sample = await buildLabelledEmail(m, { bankKey, toAddress: TO_ADDRESS });
    templates.push({
      ...parser,
      senderKey: "bank",
      fingerprint: await fingerprintOfMail(Buffer.from(sample.raw)),
    });
  }

  const runner = await startAll(config, {
    ephemeralPorts: true,
    onEvent: (e) => void events.push(e),
    budget: {
      store: budgetStore,
      now,
      // Until #233 the unknown-spend flow cannot read the receipt itself.
      readReceipt: async () =>
        pendingUnknown ? { ...pendingUnknown, direction: "out", counterparty: null } : undefined,
    },
    rules: {
      now,
      penaltyStore,
      trialStore,
      readTrialSettings: async () => opts.trial,
      // The penalty account lives in budget; resolve it from the budget store.
      isPenaltySavingsAccount: async (userId, hint) => {
        const record = await budgetStore.find(userId);
        const account = record?.accounts.find(
          (a) => a.code?.toUpperCase() === hint.trim().toUpperCase(),
        );
        return account?.kind === "penalty_savings";
      },
    },
    ingest: {
      secret: INGEST_SECRET,
      store: new MemoryIngestStore(),
      verifyDkim: createMailauthVerifier(
        dkimDnsResolver([{ domain: BANK_DKIM_DOMAIN, selector: bankKey.selector, key: bankKey }]),
      ),
      users: {
        resolve: async (token) =>
          token === TOKEN ? { userId: MONEY_USER, emailConsent: true } : null,
      },
      senderMap: [{ senderKey: "bank", senderAddress: BANK_SENDER, dkimDomain: BANK_DKIM_DOMAIN }],
      templates,
      settings: { maxEmailBytes: 1_048_576, holdMatchWindowHours: 72 },
      now,
    },
  });
  const ingestUrl = `${runner.urls.ingest}/webhook/inbound-email`;
  mountTrialJob(runner, clock, HOUR_MS);

  const envelope = (type: EventEnvelope["type"], payload: unknown): EventEnvelope =>
    ({
      id: randomUUID(),
      type,
      userId: MONEY_USER,
      occurredAt: now().toISOString(),
      schemaVersion: 1,
      payload,
    }) as EventEnvelope;

  /** Posts as the gateway does: the verified user id arrives in a header. */
  const postJson = (url: string, payload: unknown) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-id": MONEY_USER },
      body: JSON.stringify(payload),
    });

  return {
    clock,
    events,
    budgetStore,
    penaltyStore,
    trialStore,
    types: () => events.map((e) => e.type),
    ofType: <T extends EventEnvelope["type"]>(type: T) =>
      events.filter((e) => e.type === type) as EventEnvelope<T>[],
    /** The budget record of the user. */
    record: async () => (await budgetStore.find(MONEY_USER))!,
    /** Publishes an event as the owning service would. */
    emit: (type: EventEnvelope["type"], payload: unknown) =>
      runner.publish(envelope(type, payload)),
    /** Facts the unknown-spend flow reads for the next unknown mail (see #233). */
    expectUnknown: (facts: UnknownFacts) => {
      pendingUnknown = facts;
    },
    /** Signs and posts a labelled mail to the ingest webhook; returns the HTTP outcome. */
    sendMail: async (m: LabelledMail) => {
      const fixture = await buildLabelledEmail(m, { bankKey, toAddress: TO_ADDRESS });
      const [result] = await injectEmails([fixture], { url: ingestUrl, secret: INGEST_SECRET });
      return result!;
    },
    signContract: async (cycleId: string) => {
      const res = await postJson(`${runner.urls.rules}/contracts/sign`, { cycleId });
      return {
        statusCode: res.status,
        json: () => res.json() as Promise<{ data: { contract: { id: string } } }>,
      };
    },
    approveCycle: async (cycleId: string, commitmentId: string) => {
      const res = await postJson(`${runner.urls.budget}/budget/cycles/approve`, { cycleId, commitmentId });
      return { statusCode: res.status };
    },
    stop: () => runner.stop(),
  };
}

export type MoneyWorld = Awaited<ReturnType<typeof startMoneyWorld>>;
