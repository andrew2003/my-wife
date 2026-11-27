import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createApp as createBudget, MemorySampleBudgetStore } from "@my-wife/budget";
import { loadConfig } from "@my-wife/config";
import type { EventEnvelope } from "@my-wife/contracts";
import { createApp as createIngest } from "@my-wife/ingest";
import {
  createApp as createRules,
  InMemoryPenaltyStore,
  InMemoryTrialStore,
  type TrialSettings,
} from "@my-wife/rules";
import {
  BANK_DKIM_DOMAIN,
  BANK_SENDER,
  buildLabelledEmail,
  createDkimKey,
  dkimDnsResolver,
  injectEmails,
  labelledMailBody,
  labelledMailSubject,
  SimClock,
  type LabelledMail,
} from "@my-wife/test-kit";
import {
  BASIC_BANK_TEMPLATE,
  FOREIGN_CARD_TEMPLATE,
  MemoryIngestStore,
  createMailauthVerifier,
  fingerprintTemplate,
} from "./ingest-internals";

export const MONEY_USER = "0190a0a0-0000-7000-8000-0000000000f1";
export const INGEST_SECRET = "e2e-ingest-secret-e2e-ingest-secret";
const TO_ADDRESS = "u-money@in.example.test";
const HOUR_MS = 3_600_000;

type Handler = (event: EventEnvelope) => Promise<void>;

/** What a mail is expected to do, as the unknown-spend flow needs its facts from ingest (#233). */
export type UnknownFacts = {
  bankTransactionRef: string;
  bankAccountHint: string;
  amountVnd: number;
  occurredAt: string;
  memo: string;
};

/**
 * The services of the money flow (budget, ingest, rules) in one process, joined by an in-process
 * bus that routes events the way the NATS consumers do. Time comes from one `SimClock`.
 * Chat is emulated: the answer to a question is published as `notify.reply_received`.
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

  const publish = async (event: EventEnvelope): Promise<void> => {
    events.push(event);
    await route(event);
  };

  const budget = await createBudget(config, {
    store: budgetStore,
    now,
    publish,
    readReceipt: async (_userId, _receiptId) =>
      pendingUnknown ? { ...pendingUnknown, direction: "out", counterparty: null } : undefined,
  });
  const rules = await createRules(config, {
    now,
    publish,
    penaltyStore,
    trialStore,
    readTrialSettings: async () => opts.trial,
  });

  // Fingerprints of the layouts the user's bank mails use, taken from sample mails.
  const sample = (m: LabelledMail) =>
    fingerprintTemplate({
      sender: BANK_SENDER,
      subject: labelledMailSubject(m.kind),
      body: labelledMailBody(m),
    });
  const at = new Date(opts.start);
  const registered = [
    {
      m: {
        kind: "debit",
        id: "s1",
        amountVnd: 1,
        reference: "S0001",
        at,
        accountTail: "1",
        memo: "AN",
      },
      t: BASIC_BANK_TEMPLATE,
    },
    {
      m: {
        kind: "credit",
        id: "s2",
        amountVnd: 1,
        reference: "S0002",
        at,
        accountTail: "1",
        memo: "x",
      },
      t: BASIC_BANK_TEMPLATE,
    },
    {
      m: {
        kind: "card_authorization",
        id: "s3",
        foreignAmount: "9.99 USD",
        reference: "S0003",
        at,
        accountTail: "1",
        authCode: "A1",
        merchant: "M",
      },
      t: FOREIGN_CARD_TEMPLATE,
    },
    {
      m: {
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
      t: FOREIGN_CARD_TEMPLATE,
    },
  ] satisfies { m: LabelledMail; t: typeof BASIC_BANK_TEMPLATE }[];

  const ingest = await createIngest(config, {
    ingest: {
      secret: INGEST_SECRET,
      store: new MemoryIngestStore(),
      verifyDkim: createMailauthVerifier(
        dkimDnsResolver([{ domain: BANK_DKIM_DOMAIN, selector: bankKey.selector, key: bankKey }]),
      ),
      users: { resolve: async () => ({ userId: MONEY_USER, emailConsent: true }) },
      senderMap: [{ senderKey: "bank", senderAddress: BANK_SENDER, dkimDomain: BANK_DKIM_DOMAIN }],
      templates: registered.map(({ m, t }) => ({
        ...t,
        senderKey: "bank",
        fingerprint: sample(m),
      })),
      publish,
      settings: { maxEmailBytes: 1_048_576, holdMatchWindowHours: 72 },
      now,
    },
  });
  await ingest.listen({ host: "127.0.0.1", port: 0 });
  const ingestUrl = `http://127.0.0.1:${(ingest.server.address() as AddressInfo).port}/webhook/inbound-email`;

  const post = (url: string, payload: unknown) =>
    rules.inject({ method: "POST", url, payload: payload as object });
  const rulesEvent =
    (path: string): Handler =>
    async (event) => {
      const res = await post(path, event);
      if (res.statusCode !== 200) throw new Error(`rules ${path} answered ${res.statusCode}`);
    };
  const handlers: Partial<Record<EventEnvelope["type"], Handler[]>> = {
    "onboarding.step_completed": [budget.onOnboardingStepCompleted],
    "contract.signed": [budget.onContractSigned, rulesEvent("/events/contract-signed")],
    "receipt.parsed": [budget.onReceiptParsed, rulesEvent("/events/receipt-parsed")],
    "receipt.unknown": [budget.onReceiptUnknown],
    "notify.reply_received": [budget.onReplyReceived],
    "week.closed": [budget.onWeekClosed],
    "overspend.detected": [rulesEvent("/events/overspend-detected")],
  };
  async function route(event: EventEnvelope): Promise<void> {
    for (const handler of handlers[event.type] ?? []) await handler(event);
  }

  const envelope = (type: EventEnvelope["type"], payload: unknown): EventEnvelope =>
    ({
      id: randomUUID(),
      type,
      userId: MONEY_USER,
      occurredAt: now().toISOString(),
      schemaVersion: 1,
      payload,
    }) as EventEnvelope;

  clock.scheduleEvery(HOUR_MS, () => rules.runTrialJob!(clock.now()));

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
    emit: (type: EventEnvelope["type"], payload: unknown) => publish(envelope(type, payload)),
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
    /** Rules and budget routes the gateway forwards with the verified user id. */
    signContract: (cycleId: string) =>
      rules.inject({
        method: "POST",
        url: "/contracts/sign",
        headers: { "x-user-id": MONEY_USER },
        payload: { cycleId },
      }),
    approveCycle: (cycleId: string, commitmentId: string) =>
      budget.inject({
        method: "POST",
        url: "/cycles/approve",
        headers: { "x-user-id": MONEY_USER },
        payload: { cycleId, commitmentId },
      }),
    stop: async () => {
      await Promise.all([budget.close(), rules.close(), ingest.close()]);
    },
  };
}

export type MoneyWorld = Awaited<ReturnType<typeof startMoneyWorld>>;
