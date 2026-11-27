import { beforeEach, describe, expect, it } from "vitest";
import type { OutboundMessage } from "@my-wife/contracts";
import { SETTINGS } from "@my-wife/contracts";
import {
  createDispatcher,
  InMemoryInbox,
  isInQuietHours,
  type DispatchSettings,
  type Dispatcher,
} from "../src/dispatch/dispatcher";

const TZ = "Asia/Ho_Chi_Minh";
const QUIET = SETTINGS["notify.quiet_hours"].default;

function msg(over: Partial<OutboundMessage>): OutboundMessage {
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

describe("isInQuietHours", () => {
  it.each([
    ["2026-11-02T16:00:00Z", true], // 23:00 local, start is inclusive
    ["2026-11-02T19:00:00Z", true], // 02:00 local
    ["2026-11-02T23:29:00Z", true], // 06:29 local
    ["2026-11-02T23:30:00Z", false], // 06:30 local, end is exclusive
    ["2026-11-02T15:59:00Z", false], // 22:59 local
    ["2026-11-02T05:00:00Z", false], // noon local
  ])("%s -> %s with a range across midnight", (iso, expected) => {
    expect(isInQuietHours(new Date(iso), QUIET, TZ)).toBe(expected);
  });

  it("handles a range inside one day and an empty range", () => {
    const day = { from: "12:00", to: "14:00" };
    expect(isInQuietHours(new Date("2026-11-02T06:00:00Z"), day, TZ)).toBe(true);
    expect(isInQuietHours(new Date("2026-11-02T08:00:00Z"), day, TZ)).toBe(false);
    const empty = { from: "12:00", to: "12:00" };
    expect(isInQuietHours(new Date("2026-11-02T06:00:00Z"), empty, TZ)).toBe(false);
  });
});

describe("dispatcher quiet hours", () => {
  let now: Date;
  let sent: string[];
  let digests: { userId: string; ids: string[] }[];
  let published: { name: string; payload: unknown }[];
  let settings: DispatchSettings;
  let inbox: InMemoryInbox;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    now = new Date("2026-11-02T19:00:00Z"); // 02:00 local
    sent = [];
    digests = [];
    published = [];
    settings = { quietHours: QUIET, timeZone: TZ };
    inbox = new InMemoryInbox();
    dispatcher = createDispatcher({
      now: () => now,
      settings: { get: async () => settings },
      inbox,
      deliver: async (_u, m) => void sent.push(m.id),
      deliverDigest: async (userId, items) =>
        void digests.push({ userId, ids: items.map((i) => i.message.id) }),
      publish: async (e) => void published.push(e),
    });
  });

  it("holds a non-urgent message at 02:00 for the morning digest and shows it in the inbox", async () => {
    const result = await dispatcher.send("u1", msg({ id: "late", class: "timed" }));
    expect(result).toEqual({ messageId: "late", deferredToDigest: true });
    expect(sent).toEqual([]);
    expect((await inbox.list("u1")).map((i) => i.message.id)).toEqual(["late"]);

    now = new Date("2026-11-03T00:00:00Z"); // 07:00 local
    const count = await dispatcher.flushDigest("u1", "morning");
    expect(count).toBe(1);
    expect(digests).toEqual([{ userId: "u1", ids: ["late"] }]);
    expect(published.at(-1)).toEqual({
      name: "digest.sent",
      payload: { digest: "morning", itemCount: 1 },
    });
    expect(await dispatcher.flushDigest("u1", "morning")).toBe(0);
    expect((await inbox.list("u1")).map((i) => i.message.id)).toEqual(["late"]);
  });

  it("delivers a wake message at 06:00 immediately", async () => {
    now = new Date("2026-11-02T23:00:00Z"); // 06:00 local
    const result = await dispatcher.send("u1", msg({ id: "wake", class: "timed", isWakeUp: true }));
    expect(result.deferredToDigest).toBe(false);
    expect(sent).toEqual(["wake"]);
    expect((await inbox.list("u1")).map((i) => i.message.id)).toEqual(["wake"]);
  });

  it("delivers urgent messages during quiet hours", async () => {
    const result = await dispatcher.send("u1", msg({ id: "u", class: "urgent" }));
    expect(result.deferredToDigest).toBe(false);
    expect(sent).toEqual(["u"]);
  });

  it("holds question messages in quiet hours but sends them otherwise", async () => {
    const held = await dispatcher.send("u1", msg({ id: "q1", class: "question" }));
    expect(held.deferredToDigest).toBe(true);
    now = new Date("2026-11-02T05:00:00Z");
    const open = await dispatcher.send("u1", msg({ id: "q2", class: "question" }));
    expect(open.deferredToDigest).toBe(false);
    expect(sent).toEqual(["q2"]);
  });

  it("always batches digest-class messages", async () => {
    now = new Date("2026-11-02T05:00:00Z");
    const result = await dispatcher.send("u1", msg({ id: "d", class: "digest" }));
    expect(result.deferredToDigest).toBe(true);
    expect(sent).toEqual([]);
  });

  it("uses the user's quiet hours setting, not a hard-coded range", async () => {
    settings = { quietHours: { from: "01:00", to: "03:00" }, timeZone: TZ };
    expect((await dispatcher.send("u1", msg({ id: "a" }))).deferredToDigest).toBe(true);
    settings = { quietHours: { from: "04:00", to: "05:00" }, timeZone: TZ };
    expect((await dispatcher.send("u1", msg({ id: "b" }))).deferredToDigest).toBe(false);
  });

  it("keeps the inbox entry when chat delivery fails", async () => {
    const failing = createDispatcher({
      now: () => new Date("2026-11-02T05:00:00Z"),
      settings: { get: async () => settings },
      inbox,
      deliver: async () => {
        throw new Error("down");
      },
      deliverDigest: async () => {},
      publish: async () => {},
    });
    await failing.send("u1", msg({ id: "f", class: "urgent" }));
    expect((await inbox.list("u1")).map((i) => i.message.id)).toEqual(["f"]);
  });
});
