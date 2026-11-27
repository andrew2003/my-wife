import { beforeEach, describe, expect, it } from "vitest";
import type { OutboundMessage } from "@my-wife/contracts";
import { SETTINGS } from "@my-wife/contracts";
import {
  createDispatcher,
  InMemoryInbox,
  type DispatchSettings,
  type Dispatcher,
} from "../src/dispatch/dispatcher";

const TZ = "Asia/Ho_Chi_Minh";

function msg(id: string): OutboundMessage {
  return {
    id,
    class: "digest",
    message: { key: "notify.test_message", params: {} },
    locale: "en",
    sourceService: "schedule",
    isWakeUp: false,
    createdAt: "2026-11-02T00:00:00.000Z",
  };
}

describe("scheduled digests", () => {
  let now: Date;
  let settings: DispatchSettings;
  let digests: { userId: string; kind: string; ids: string[] }[];
  let published: { name: string; payload: unknown }[];
  let dispatcher: Dispatcher;

  beforeEach(() => {
    now = new Date("2026-11-02T23:00:00Z"); // 06:00 local
    settings = { quietHours: SETTINGS["notify.quiet_hours"].default, timeZone: TZ };
    digests = [];
    published = [];
    dispatcher = createDispatcher({
      now: () => now,
      settings: { get: async () => settings },
      inbox: new InMemoryInbox(),
      deliver: async () => {},
      deliverDigest: async (userId, items, kind) =>
        void digests.push({ userId, kind, ids: items.map((i) => i.message.id) }),
      publish: async (e) => void published.push(e),
    });
  });

  it("sends the morning digest at the default time with the day's items", async () => {
    await dispatcher.send("u1", msg("a"));
    await dispatcher.send("u1", msg("b"));
    await dispatcher.runDigests(["u1"]);
    expect(published).toEqual([]); // 06:00 local, not yet due

    now = new Date("2026-11-03T00:00:00Z"); // 07:00 local
    await dispatcher.runDigests(["u1"]);
    expect(digests).toEqual([{ userId: "u1", kind: "morning", ids: ["a", "b"] }]);
    expect(published).toEqual([
      { name: "digest.sent", payload: { digest: "morning", itemCount: 2 } },
    ]);
  });

  it("sends the evening digest at the default time", async () => {
    now = new Date("2026-11-03T14:30:00Z"); // 21:30 local
    await dispatcher.send("u1", msg("e"));
    await dispatcher.runDigests(["u1"]);
    expect(digests).toEqual([{ userId: "u1", kind: "evening", ids: ["e"] }]);
    expect(published).toEqual([
      { name: "digest.sent", payload: { digest: "evening", itemCount: 1 } },
    ]);
  });

  it("sends each digest once per local day and again the next day", async () => {
    now = new Date("2026-11-03T00:00:00Z");
    await dispatcher.send("u1", msg("a"));
    await dispatcher.runDigests(["u1"]);
    await dispatcher.send("u1", msg("b"));
    now = new Date("2026-11-03T00:05:00Z");
    await dispatcher.runDigests(["u1"]);
    expect(digests).toHaveLength(1);

    now = new Date("2026-11-04T00:00:00Z");
    await dispatcher.runDigests(["u1"]);
    expect(digests.map((d) => d.ids)).toEqual([["a"], ["b"]]);
  });

  it("uses configured digest times, not the defaults", async () => {
    settings = { ...settings, morningDigestTime: "09:00", eveningDigestTime: "20:00" };
    await dispatcher.send("u1", msg("a"));
    now = new Date("2026-11-03T00:00:00Z"); // 07:00 local
    await dispatcher.runDigests(["u1"]);
    expect(digests).toEqual([]);
    now = new Date("2026-11-03T02:00:00Z"); // 09:00 local
    await dispatcher.runDigests(["u1"]);
    expect(digests.map((d) => d.kind)).toEqual(["morning"]);
  });

  it("keeps users independent", async () => {
    now = new Date("2026-11-03T00:00:00Z");
    await dispatcher.send("u1", msg("a"));
    await dispatcher.send("u2", msg("b"));
    await dispatcher.runDigests(["u1", "u2"]);
    expect(digests.map((d) => d.userId)).toEqual(["u1", "u2"]);
  });
});
