import { afterEach, describe, expect, it } from "vitest";
import { SimClock, WEEK_MS } from "../src/clock";
import { DiscordFake } from "../src/fakes/discord";
import { TelegramFake } from "../src/fakes/telegram";
import { createFakeDiscordChannel, createFakeTelegramChannel } from "../src/fakes/channels";

const START = "2026-11-02T00:00:00.000Z";
const msg = {
  id: "m1",
  class: "timed" as const,
  message: { key: "k", params: {} },
  locale: "vi" as const,
  sourceService: "notify" as const,
  isWakeUp: false,
  createdAt: START,
};
const fakes: Array<{ stop(): Promise<void> }> = [];
afterEach(async () => void (await Promise.all(fakes.splice(0).map((f) => f.stop()))));

describe("fakes follow the injected clock", () => {
  it("telegram stamps messages, updates and send results with simulated time", async () => {
    const clock = new SimClock(START);
    const tg = new TelegramFake({ clock });
    fakes.push(tg);
    await tg.start();
    const channel = createFakeTelegramChannel(tg);
    await channel.send("1", msg);
    await clock.advanceWeeks(1);
    const res = await channel.send("1", msg);
    const [first, second] = tg.botMessages();
    expect(first!.sentAt).toBe(Date.parse(START));
    expect(second!.sentAt).toBe(Date.parse(START) + WEEK_MS);
    expect(res.acceptedAt).toBe(new Date(Date.parse(START) + WEEK_MS).toISOString());
    tg.injectText(1, "hi");
    const upd = (await (
      await fetch(`${tg.url}/bot${tg.token}/getUpdates`, { method: "POST", body: "{}" })
    ).json()) as any;
    expect(upd.result[0].message.date).toBe((Date.parse(START) + WEEK_MS) / 1000);
    const reply = await channel.parseReply(upd.result[0]);
    expect(reply).toMatchObject({ sentAt: new Date(Date.parse(START) + WEEK_MS).toISOString() });
  });

  it("discord stamps messages with simulated time", async () => {
    const clock = new SimClock(START);
    const dc = new DiscordFake({ clock });
    fakes.push(dc);
    await dc.start();
    await clock.advanceDays(3);
    await createFakeDiscordChannel(dc).send("c1", msg);
    expect(dc.lastBotMessage("c1")!.sentAt).toBe(Date.parse(START) + 3 * 86_400_000);
  });
});
