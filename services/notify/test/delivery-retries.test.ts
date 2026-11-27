import { beforeEach, describe, expect, it } from "vitest";
import type { OutboundMessage } from "@my-wife/contracts";
import { SETTINGS } from "@my-wife/contracts";
import {
  createDispatcher,
  DEFAULT_RETRY_BACKOFF_SECONDS,
  InMemoryInbox,
  type DispatchSettings,
  type Dispatcher,
} from "../src/dispatch/dispatcher";

const TZ = "Asia/Ho_Chi_Minh";
const NOON = new Date("2026-11-02T05:00:00Z"); // 12:00 local, outside quiet hours

function msg(over: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    id: "m1",
    class: "timed",
    message: { key: "notify.test_message", params: {} },
    locale: "en",
    sourceService: "schedule",
    isWakeUp: false,
    createdAt: "2026-11-02T00:00:00.000Z",
    ...over,
  };
}

describe("delivery retries", () => {
  let now: Date;
  let attempts: number;
  let adapterDown: boolean;
  let published: { name: string; payload: unknown }[];
  let settings: DispatchSettings;
  let inbox: InMemoryInbox;
  let dispatcher: Dispatcher;

  const advance = (seconds: number) => {
    now = new Date(now.getTime() + seconds * 1000);
  };
  const build = (backoff?: number[]) =>
    createDispatcher({
      now: () => now,
      settings: { get: async () => settings },
      inbox,
      deliver: async () => {
        attempts += 1;
        if (adapterDown) throw new Error("down");
      },
      deliverDigest: async () => {},
      publish: async (e) => void published.push(e),
      ...(backoff ? { retryBackoffSeconds: backoff } : {}),
    });

  beforeEach(() => {
    now = NOON;
    attempts = 0;
    adapterDown = true;
    published = [];
    settings = {
      quietHours: SETTINGS["notify.quiet_hours"].default,
      timeZone: TZ,
      deliveryRetries: SETTINGS["notify.delivery_retries"].default,
    };
    inbox = new InMemoryInbox();
    dispatcher = build();
  });

  it("keeps the message in the inbox, retries on the backoff and emits delivery_failed", async () => {
    const [b1, b2, b3] = DEFAULT_RETRY_BACKOFF_SECONDS;
    await dispatcher.send("u1", msg());
    expect((await inbox.list("u1")).map((i) => i.message.id)).toEqual(["m1"]);
    expect(attempts).toBe(1);

    advance(b1! - 1);
    await dispatcher.runRetries();
    expect(attempts).toBe(1); // too early

    advance(1);
    await dispatcher.runRetries();
    expect(attempts).toBe(2);

    advance(b2! - 1);
    await dispatcher.runRetries();
    expect(attempts).toBe(2);
    advance(1);
    await dispatcher.runRetries();
    expect(attempts).toBe(3);
    expect(published).toEqual([]);

    advance(b3!);
    await dispatcher.runRetries();
    expect(attempts).toBe(4); // first send + 3 retries
    expect(published).toEqual([
      {
        name: "notify.delivery_failed",
        payload: { messageId: "m1", channel: "telegram", attempts: 4 },
      },
    ]);

    // No further retries, no second event, the inbox keeps the message.
    advance(100000);
    await dispatcher.runRetries();
    expect(attempts).toBe(4);
    expect(published).toHaveLength(1);
    expect((await inbox.list("u1")).map((i) => i.message.id)).toEqual(["m1"]);
  });

  it("stops retrying after a successful delivery and emits nothing", async () => {
    await dispatcher.send("u1", msg());
    adapterDown = false;
    advance(DEFAULT_RETRY_BACKOFF_SECONDS[0]!);
    await dispatcher.runRetries();
    expect(attempts).toBe(2);
    advance(100000);
    await dispatcher.runRetries();
    expect(attempts).toBe(2);
    expect(published).toEqual([]);
  });

  it("uses the configured retry count and backoff", async () => {
    settings = { ...settings, deliveryRetries: 1 };
    dispatcher = build([5]);
    await dispatcher.send("u1", msg());
    advance(4);
    await dispatcher.runRetries();
    expect(attempts).toBe(1);
    advance(1);
    await dispatcher.runRetries();
    expect(attempts).toBe(2);
    expect(published).toEqual([
      {
        name: "notify.delivery_failed",
        payload: { messageId: "m1", channel: "telegram", attempts: 2 },
      },
    ]);
  });

  it("with zero retries emits delivery_failed right after the first failure", async () => {
    settings = { ...settings, deliveryRetries: 0 };
    await dispatcher.send("u1", msg());
    expect(published).toEqual([
      {
        name: "notify.delivery_failed",
        payload: { messageId: "m1", channel: "telegram", attempts: 1 },
      },
    ]);
  });
});
