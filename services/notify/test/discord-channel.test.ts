import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatChannel, OutboundMessage, Question } from "@my-wife/contracts";
import { DiscordFake, SimClock, TelegramFake } from "@my-wife/test-kit";
import { createDiscordChannel } from "../src/channels/discord";
import { createTelegramChannel } from "../src/channels/telegram";
import {
  ChannelService,
  InMemoryChannelLinkStore,
  type PhotoHandoff,
  type PublishedEvent,
} from "../src/channels/channel-service";

const CHANNEL = "777";
const message: OutboundMessage = {
  id: "m1",
  class: "urgent",
  message: { key: "notify.test_message", params: {} },
  locale: "en",
  sourceService: "monitor",
  isWakeUp: false,
  createdAt: "2026-11-02T00:00:00.000Z",
};

let fake: DiscordFake;
let events: PublishedEvent[];
let photos: PhotoHandoff[];
let service: ChannelService;
let channel: ChatChannel;
let frames: unknown[];
let socket: WebSocket;

beforeEach(async () => {
  const clock = new SimClock("2026-11-02T00:00:00.000Z");
  fake = new DiscordFake({ clock });
  await fake.start();
  channel = createDiscordChannel({ baseUrl: fake.url, token: fake.token, clock });
  const links = new InMemoryChannelLinkStore();
  links.add({ userId: "u1", channel: "discord", externalId: CHANNEL });
  events = [];
  photos = [];
  service = new ChannelService({
    channels: [channel],
    links,
    publish: async (e) => void events.push(e),
    onPhoto: async (p) => void photos.push(p),
  });
  // Connect to the emulated gateway the way the bot would, and collect dispatch frames.
  frames = [];
  socket = new WebSocket(fake.gatewayUrl);
  await new Promise<void>((resolve) => {
    socket.onmessage = (ev) => {
      const frame = JSON.parse(String(ev.data)) as { op: number; t?: string };
      if (frame.op === 10) {
        socket.send(JSON.stringify({ op: 2, d: { token: fake.token } }));
      } else if (frame.t === "READY") resolve();
      else if (frame.op === 0) frames.push(frame);
    };
  });
});
afterEach(async () => {
  socket.close();
  await fake.stop();
});

async function nextFrame(): Promise<unknown> {
  for (let i = 0; i < 100 && frames.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  return frames.shift();
}

describe("Discord channel behind the shared interface", () => {
  it("delivers a notification to the linked channel and emits notify.sent", async () => {
    await service.deliver("u1", "discord", message);
    expect(fake.lastBotMessage(CHANNEL)?.text).toBe("Notification channel connected.");
    expect(events[0]).toMatchObject({
      name: "notify.sent",
      payload: { messageId: "m1", class: "urgent", channel: "discord" },
    });
  });

  it("renders the text in the message locale", async () => {
    await service.deliver("u1", "discord", { ...message, locale: "vi" });
    const text = fake.lastBotMessage(CHANNEL)?.text;
    expect(text).not.toBe("Notification channel connected.");
    expect(text).not.toBe("notify.test_message");
  });

  it("does not emit notify.sent when the channel fails", async () => {
    fake.setDown(true);
    await expect(service.deliver("u1", "discord", message)).rejects.toThrow();
    expect(events).toHaveLength(0);
  });

  it("emits notify.reply_received for a text reply with chat context", async () => {
    fake.injectText(CHANNEL, "d-user", "hello bot");
    await service.handleUpdate("discord", await nextFrame());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      name: "notify.reply_received",
      payload: { value: "hello bot", via: "chat", kind: "text", questionId: `chat:${CHANNEL}` },
      context: { channel: "discord", externalId: CHANNEL, userId: "u1" },
    });
  });

  it("emits the same reply event as Telegram for the same text", async () => {
    const clock = new SimClock("2026-11-02T00:00:00.000Z");
    const tg = new TelegramFake({ clock });
    await tg.start();
    try {
      const links = new InMemoryChannelLinkStore();
      links.add({ userId: "u1", channel: "telegram", externalId: "42" });
      const tgEvents: PublishedEvent[] = [];
      const tgService = new ChannelService({
        channels: [createTelegramChannel({ baseUrl: tg.url, token: tg.token, clock })],
        links,
        publish: async (e) => void tgEvents.push(e),
        onPhoto: async () => {},
      });
      tg.injectText("42", "hello bot");
      const res = await fetch(`${tg.url}/bot${tg.token}/getUpdates`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const [update] = ((await res.json()) as { result: unknown[] }).result;
      await tgService.handleUpdate("telegram", update);

      fake.injectText(CHANNEL, "d-user", "hello bot");
      await service.handleUpdate("discord", await nextFrame());

      // Only the chat identity (and the channel name in the context) differ.
      const strip = (e?: PublishedEvent) => {
        const p = { ...(e?.payload as Record<string, unknown>) };
        delete p.questionId;
        return { name: e?.name, payload: p };
      };
      expect(strip(events[0])).toEqual(strip(tgEvents[0]));
    } finally {
      await tg.stop();
    }
  });

  it("sends a question with buttons and parses a tap as a button reply", async () => {
    const question = {
      id: "q1",
      options: [
        { value: "food", labelKey: "notify.question.other" },
        { value: "fun", labelKey: "notify.question.other" },
      ],
    } as unknown as Question;
    await channel.sendQuestion(CHANNEL, message, question);
    const sent = fake.lastBotMessage(CHANNEL)!;
    expect(sent.buttons.map((b) => b.value)).toEqual(["q1:food", "q1:fun"]);

    fake.tapButton(CHANNEL, "d-user", sent.id, "q1:fun");
    const reply = await channel.parseReply(await nextFrame());
    expect(reply).toMatchObject({
      kind: "button",
      questionId: "q1",
      value: "fun",
      externalId: CHANNEL,
    });
  });

  it("parses a button tap in a direct message, where the user is not under member", async () => {
    const reply = await channel.parseReply({
      t: "INTERACTION_CREATE",
      d: { channel_id: CHANNEL, user: { id: "d-user" }, data: { custom_id: "q1:fun" } },
    });
    expect(reply).toMatchObject({ kind: "button", questionId: "q1", value: "fun" });
  });

  it("does not follow redirects when downloading an attachment", async () => {
    const target = createServer((_req, res) => res.end("secret"));
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
    const port = (target.address() as AddressInfo).port;
    const redirector = createServer((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${port}/` });
      res.end();
    });
    await new Promise<void>((r) => redirector.listen(0, "127.0.0.1", r));
    const rport = (redirector.address() as AddressInfo).port;
    const redirecting = createDiscordChannel({
      baseUrl: `http://127.0.0.1:${rport}`,
      token: "t",
      clock: { now: () => new Date() },
    });
    try {
      await expect(
        redirecting.receivePhoto({
          kind: "photo",
          challengeId: null,
          fileRef: `http://127.0.0.1:${rport}/a`,
          externalId: CHANNEL,
          sentAt: "2026-11-02T00:00:00.000Z",
        }),
      ).rejects.toThrow();
    } finally {
      redirector.close();
      target.close();
    }
  });

  it("requires https for the Discord CDN hosts", async () => {
    await expect(
      channel.receivePhoto({
        kind: "photo",
        challengeId: null,
        fileRef: "http://cdn.discordapp.com/a.jpg",
        externalId: CHANNEL,
        sentAt: "2026-11-02T00:00:00.000Z",
      }),
    ).rejects.toThrow(/not allowed/);
  });

  it("ignores updates from a channel that is not linked", async () => {
    fake.injectText("999", "intruder", "hi");
    await service.handleUpdate("discord", await nextFrame());
    expect(events).toHaveLength(0);
  });

  it("ignores bot messages and unknown frames", async () => {
    expect(await channel.parseReply({ t: "TYPING_START", d: { channel_id: CHANNEL } })).toBeNull();
    expect(
      await channel.parseReply({
        t: "MESSAGE_CREATE",
        d: { channel_id: CHANNEL, author: { bot: true }, content: "x" },
      }),
    ).toBeNull();
    expect(await channel.parseReply(null)).toBeNull();
  });

  it("matches a photo to the photo request and hands the bytes to the caller", async () => {
    await service.requestPhoto("u1", "discord", message, "challenge-1");
    expect(fake.lastBotMessage(CHANNEL)?.text).toBe("Notification channel connected.");

    fake.injectPhoto(CHANNEL, "d-user", new Uint8Array([1, 2, 3, 4]));
    await service.handleUpdate("discord", await nextFrame());

    expect(photos).toHaveLength(1);
    expect(Array.from(photos[0]!.bytes)).toEqual([1, 2, 3, 4]);
    expect(photos[0]).toMatchObject({
      userId: "u1",
      externalId: CHANNEL,
      channel: "discord",
      challengeId: "challenge-1",
    });
    expect(events).toHaveLength(0);
  });

  it("refuses to download an attachment from an unknown host", async () => {
    await expect(
      channel.receivePhoto({
        kind: "photo",
        challengeId: null,
        fileRef: "http://169.254.169.254/latest",
        externalId: CHANNEL,
        sentAt: "2026-11-02T00:00:00.000Z",
      }),
    ).rejects.toThrow(/not allowed/);
  });

  it("links a channel with a one-time token", async () => {
    fake.injectText("555", "d-user", "/start tok-1");
    const frame = await nextFrame();
    await expect(channel.link("wrong", frame)).rejects.toThrow(/does not match/);
    await expect(channel.link("tok-1", frame)).resolves.toEqual({ externalId: "555" });
  });

  it("reports health", async () => {
    expect(await channel.health()).toEqual({ healthy: true });
    const bad = createDiscordChannel({
      baseUrl: fake.url,
      token: "wrong",
      clock: { now: () => new Date() },
    });
    expect((await bad.health()).healthy).toBe(false);
  });
});
