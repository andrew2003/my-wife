import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EVENT_SCHEMA_VERSION } from "@my-wife/contracts";
import { SimClock, TelegramFake } from "@my-wife/test-kit";
import { createTelegramChannel } from "../src/channels/telegram";
import {
  ChannelService,
  InMemoryChannelLinkStore,
  type PublishedEvent,
} from "../src/channels/channel-service";
import { InMemoryQuestionStore, QuestionService } from "../src/questions/question-service";

const CHAT = "4242";
const clock = new SimClock("2026-11-02T00:00:00.000Z");

function envelope(type: string, payload: unknown): unknown {
  return {
    id: `evt-${type}`,
    occurredAt: "2026-11-02T00:00:00.000Z",
    userId: "u1",
    schemaVersion: EVENT_SCHEMA_VERSION,
    type,
    payload,
  };
}

const askPayload = {
  questionId: "q1",
  kind: "budget_category",
  subjectRef: "txn-1",
  options: [
    { value: "food", labelKey: "notify.option.food" },
    { value: "transport", labelKey: "notify.option.transport" },
    { value: "other", labelKey: "notify.option.other" },
  ],
  expiresAt: "2026-11-03T00:00:00.000Z",
  params: {},
};

let fake: TelegramFake;
let events: PublishedEvent[];
let channels: ChannelService;
let questions: QuestionService;

async function updates(): Promise<unknown[]> {
  const res = await fetch(`${fake.url}/bot${fake.token}/getUpdates`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  return ((await res.json()) as { result: unknown[] }).result;
}

async function tap(messageId: string, value: string) {
  const before = (await updates()).length;
  fake.tapButton(CHAT, messageId, `q1:${value}`);
  const all = await updates();
  await channels.handleUpdate("telegram", all[before]);
}

beforeEach(async () => {
  fake = new TelegramFake({ clock });
  await fake.start();
  const links = new InMemoryChannelLinkStore();
  links.add({ userId: "u1", channel: "telegram", externalId: CHAT });
  events = [];
  questions = new QuestionService({
    store: new InMemoryQuestionStore(),
    clock,
    defaultLocale: "en",
    publish: async (e) => void events.push(e),
    deliver: (userId, message, question) => channels.deliverQuestion(userId, message, question),
  });
  channels = new ChannelService({
    channels: [createTelegramChannel({ baseUrl: fake.url, token: fake.token, clock })],
    links,
    publish: async (e) => void events.push(e),
    onPhoto: async () => undefined,
    questions,
  });
});
afterEach(() => fake.stop());

describe("questions with buttons", () => {
  it("sends one message with three buttons for an ask.* event", async () => {
    await questions.handleEvent(envelope("ask.budget_category", askPayload));
    expect(fake.botMessages(CHAT)).toHaveLength(1);
    const msg = fake.lastBotMessage(CHAT)!;
    expect(msg.buttons?.map((b) => b.value)).toEqual(["q1:food", "q1:transport", "q1:other"]);
  });

  it("counts only the first of two taps on different options", async () => {
    await questions.handleEvent(envelope("ask.budget_category", askPayload));
    const id = fake.lastBotMessage(CHAT)!.id;
    await tap(id, "food");
    await tap(id, "transport");
    const replies = events.filter((e) => e.name === "notify.reply_received");
    expect(replies).toHaveLength(1);
    expect(replies[0]!.payload).toMatchObject({ questionId: "q1", value: "food", via: "chat" });
  });

  it("counts a first reply from the web and ignores a later chat tap", async () => {
    await questions.handleEvent(envelope("ask.budget_category", askPayload));
    const id = fake.lastBotMessage(CHAT)!.id;
    expect(await questions.answer("u1", "q1", "transport", "web")).toBe(true);
    await tap(id, "food");
    const replies = events.filter((e) => e.name === "notify.reply_received");
    expect(replies).toHaveLength(1);
    expect(replies[0]!.payload).toMatchObject({ value: "transport", via: "web" });
  });

  it("ignores a value that is not one of the options", async () => {
    await questions.handleEvent(envelope("ask.budget_category", askPayload));
    expect(await questions.answer("u1", "q1", "bogus", "web")).toBe(false);
    expect(events.filter((e) => e.name === "notify.reply_received")).toHaveLength(0);
  });

  it("sends the same question once when the event is redelivered", async () => {
    await questions.handleEvent(envelope("ask.budget_category", askPayload));
    await questions.handleEvent(envelope("ask.budget_category", askPayload));
    expect(fake.botMessages(CHAT)).toHaveLength(1);
  });

  it.each([
    ["anomaly.opened", { anomalyId: "a1", cycleId: "c1", kind: "x" }],
    ["penalty.issued", {}],
    ["notify.sent", {}],
    ["unknown.thing", {}],
  ])("sends no question for %s", async (type, payload) => {
    await questions.handleEvent(envelope(type, payload));
    expect(fake.botMessages(CHAT)).toHaveLength(0);
  });
});
