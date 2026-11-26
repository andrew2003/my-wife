import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatChannel, OutboundMessage, Question } from "@my-wife/contracts";
import { DiscordFake } from "../src/fakes/discord";
import { TelegramFake } from "../src/fakes/telegram";
import { createFakeDiscordChannel, createFakeTelegramChannel } from "../src/fakes/channels";

const message: OutboundMessage = {
  id: "m1",
  class: "question",
  message: { key: "budget.ask_category", params: { amount: 50000 } },
  locale: "vi",
  sourceService: "budget",
  isWakeUp: false,
  createdAt: "2026-11-02T00:00:00.000Z",
};
const question: Question = {
  id: "q1",
  sourceService: "budget",
  kind: "budget_category",
  options: [
    { value: "food", labelKey: "category.food" },
    { value: "fun", labelKey: "category.fun" },
  ],
  expiresAt: "2026-11-03T00:00:00.000Z",
  state: "created",
};

interface Harness {
  name: string;
  chat: string;
  channel: ChatChannel;
  setup(): Promise<void>;
  teardown(): Promise<void>;
  lastBot(): { text: string; buttons: Array<{ label: string; value: string }> } | undefined;
  /** Injects a user message and returns the raw update the adapter would receive. */
  userText(text: string): Promise<unknown>;
  userTap(value: string): Promise<unknown>;
  userPhoto(bytes: Uint8Array): Promise<unknown>;
  setDown(down: boolean): void;
}

function telegramHarness(): Harness {
  const fake = new TelegramFake();
  const channel = createFakeTelegramChannel(fake);
  const take = async () => {
    const res = await fetch(`${fake.url}/bot${fake.token}/getUpdates`, {
      method: "POST",
      body: "{}",
    });
    const updates = ((await res.json()) as any).result as any[];
    return updates.at(-1);
  };
  return {
    name: "telegram",
    chat: "42",
    channel,
    setup: () => fake.start(),
    teardown: () => fake.stop(),
    lastBot: () => fake.lastBotMessage("42"),
    async userText(text) {
      fake.injectText(42, text);
      return take();
    },
    async userTap(value) {
      fake.tapButton(42, fake.lastBotMessage("42")!.id, value);
      return take();
    },
    async userPhoto(bytes) {
      fake.injectPhoto(42, bytes);
      return take();
    },
    setDown: (d) => fake.setDown(d),
  };
}

function discordHarness(): Harness {
  const fake = new DiscordFake();
  const channel = createFakeDiscordChannel(fake);
  return {
    name: "discord",
    chat: "c1",
    channel,
    setup: () => fake.start(),
    teardown: () => fake.stop(),
    lastBot: () => fake.lastBotMessage("c1"),
    // The Discord adapter receives gateway payloads; the harness builds the same payload shapes.
    async userText(text) {
      return {
        t: "MESSAGE_CREATE",
        d: { id: "9", channel_id: "c1", author: { id: "u1" }, content: text, attachments: [] },
      };
    },
    async userTap(value) {
      return {
        t: "INTERACTION_CREATE",
        d: { channel_id: "c1", member: { user: { id: "u1" } }, data: { custom_id: value } },
      };
    },
    async userPhoto(bytes) {
      const att = fake.injectPhoto("c1", "u1", bytes);
      return {
        t: "MESSAGE_CREATE",
        d: { id: "9", channel_id: "c1", author: { id: "u1" }, content: "", attachments: [att] },
      };
    },
    setDown: (d) => fake.setDown(d),
  };
}

describe.each([telegramHarness, discordHarness])("fake channel %#", (make) => {
  let h: Harness;
  beforeEach(async () => {
    h = make();
    await h.setup();
  });
  afterEach(() => h.teardown());

  it("reports the channel kind and health", async () => {
    expect(h.channel.kind).toBe(h.name);
    expect(await h.channel.health()).toEqual({ healthy: true });
    h.setDown(true);
    // health does not use the send path, so an outage of sends is not "unhealthy" by itself
    expect((await h.channel.health()).healthy).toBe(true);
  });

  it("sends a locale key, never prebuilt text, and returns a send result", async () => {
    const res = await h.channel.send(h.chat, message);
    expect(res.externalMessageId).toBeTruthy();
    expect(h.lastBot()?.text).toBe("budget.ask_category");
  });

  it("sends a question with one button per option, value carries question id and value", async () => {
    await h.channel.sendQuestion(h.chat, message, question);
    expect(h.lastBot()?.buttons).toEqual([
      { label: "category.food", value: "q1:food" },
      { label: "category.fun", value: "q1:fun" },
    ]);
  });

  it("parses a button tap into a button reply", async () => {
    await h.channel.sendQuestion(h.chat, message, question);
    const reply = await h.channel.parseReply(await h.userTap("q1:fun"));
    expect(reply).toMatchObject({ kind: "button", questionId: "q1", value: "fun" });
  });

  it("parses free text as text", async () => {
    const reply = await h.channel.parseReply(await h.userText("ate pho 50k"));
    expect(reply).toMatchObject({ kind: "text", text: "ate pho 50k" });
  });

  it("returns null for updates that are not replies", async () => {
    expect(await h.channel.parseReply({ something: "else" })).toBeNull();
  });

  it("parses and downloads a photo reply", async () => {
    const reply = await h.channel.parseReply(await h.userPhoto(new Uint8Array([7, 7, 7])));
    expect(reply?.kind).toBe("photo");
    const bytes = await h.channel.receivePhoto(reply as Extract<typeof reply, { kind: "photo" }>);
    expect([...bytes]).toEqual([7, 7, 7]);
  });

  it("links a one-time token sent as /start <token>", async () => {
    const raw = await h.userText("/start tok-123");
    expect(await h.channel.link("tok-123", raw)).toEqual({ externalId: expect.any(String) });
    await expect(h.channel.link("other-token", raw)).rejects.toThrow();
  });

  it("rejects sends during an outage", async () => {
    h.setDown(true);
    await expect(h.channel.send(h.chat, message)).rejects.toThrow();
  });

  it("sends a photo request that mentions the challenge id", async () => {
    await h.channel.sendPhotoRequest(h.chat, message, "ch-1");
    expect(h.lastBot()?.buttons).toEqual([]);
    expect(h.lastBot()?.text).toBe("budget.ask_category");
    const reply = await h.channel.parseReply(await h.userPhoto(new Uint8Array([1])));
    expect(reply).toMatchObject({ kind: "photo", challengeId: "ch-1" });
  });
});
