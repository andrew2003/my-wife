import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OutboundMessage } from "@my-wife/contracts";
import { SimClock, TelegramFake } from "@my-wife/test-kit";
import { createTelegramChannel } from "../src/channels/telegram";
import {
  ChannelService,
  InMemoryChannelLinkStore,
  type PhotoHandoff,
  type PublishedEvent,
} from "../src/channels/channel-service";

const CHAT = "4242";
const message: OutboundMessage = {
  id: "m1",
  class: "urgent",
  message: { key: "notify.test_message", params: {} },
  locale: "en",
  sourceService: "monitor",
  isWakeUp: false,
  createdAt: "2026-11-02T00:00:00.000Z",
};

let fake: TelegramFake;
let events: PublishedEvent[];
let service: ChannelService;
let photos: PhotoHandoff[];

beforeEach(async () => {
  const clock = new SimClock("2026-11-02T00:00:00.000Z");
  fake = new TelegramFake({ clock });
  await fake.start();
  const links = new InMemoryChannelLinkStore();
  links.add({ userId: "u1", channel: "telegram", externalId: CHAT });
  events = [];
  photos = [];
  service = new ChannelService({
    channels: [createTelegramChannel({ baseUrl: fake.url, token: fake.token, clock })],
    links,
    publish: async (e) => void events.push(e),
    onPhoto: async (p) => void photos.push(p),
  });
});
afterEach(() => fake.stop());

async function getUpdates(): Promise<unknown[]> {
  const res = await fetch(`${fake.url}/bot${fake.token}/getUpdates`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  return ((await res.json()) as { result: unknown[] }).result;
}

describe("channel service with emulated Telegram", () => {
  it("delivers a notification to the linked chat and emits notify.sent", async () => {
    await service.deliver("u1", "telegram", message);
    expect(fake.lastBotMessage(CHAT)?.text).toBe("Notification channel connected.");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      name: "notify.sent",
      payload: { messageId: "m1", class: "urgent", channel: "telegram" },
    });
  });

  it("renders the text in the message locale", async () => {
    await service.deliver("u1", "telegram", { ...message, locale: "vi" });
    const text = fake.lastBotMessage(CHAT)?.text;
    expect(text).toBeTruthy();
    expect(text).not.toBe("Notification channel connected.");
    expect(text).not.toBe("notify.test_message");
  });

  it("does not emit notify.sent when the channel fails", async () => {
    fake.setDown(true);
    await expect(service.deliver("u1", "telegram", message)).rejects.toThrow();
    expect(events).toHaveLength(0);
  });

  it("rejects delivery when the user has no linked chat", async () => {
    await expect(service.deliver("nobody", "telegram", message)).rejects.toThrow(/not linked/);
  });

  it("emits notify.reply_received with chat context for a user text", async () => {
    fake.injectText(CHAT, "hello bot");
    const [update] = await getUpdates();
    await service.handleUpdate("telegram", update);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      name: "notify.reply_received",
      payload: { value: "hello bot", via: "chat", kind: "text" },
      context: { channel: "telegram", externalId: CHAT, userId: "u1" },
    });
  });

  it("ignores updates from a chat that is not linked", async () => {
    fake.injectText("999", "intruder");
    const [update] = await getUpdates();
    await service.handleUpdate("telegram", update);
    expect(events).toHaveLength(0);
  });

  it("shows the photo prompt and hands the bytes and chat context to the caller", async () => {
    await service.requestPhoto("u1", "telegram", message, "challenge-1");
    expect(fake.lastBotMessage(CHAT)?.text).toBe("Notification channel connected.");

    fake.injectPhoto(CHAT, new Uint8Array([1, 2, 3, 4]));
    const [update] = await getUpdates();
    await service.handleUpdate("telegram", update);

    expect(photos).toHaveLength(1);
    expect(Array.from(photos[0]!.bytes)).toEqual([1, 2, 3, 4]);
    expect(photos[0]).toMatchObject({
      userId: "u1",
      externalId: CHAT,
      channel: "telegram",
      challengeId: "challenge-1",
    });
    // Nothing is persisted by notify and no reply event carries the image.
    expect(events).toHaveLength(0);
  });
});
