import { describe, expect, it } from "vitest";
import { SETTINGS, type CalendarProvider } from "@my-wife/contracts";
import {
  CalendarProviderRouter,
  type CalendarItem,
  type ProviderCalendar,
} from "../src/calendar/calendar-providers";

const NOW = new Date("2026-11-27T00:00:00Z");
const ITEM: CalendarItem = {
  id: "task-1",
  title: "Write report",
  startsAt: "2026-11-30T02:00:00Z",
  endsAt: "2026-11-30T03:00:00Z",
};

function setup(chosen: CalendarProvider[]) {
  const calls: string[] = [];
  const make = (name: CalendarProvider): ProviderCalendar => ({
    upsert: async (u, i) => void calls.push(`${name}:upsert:${u}:${i.id}`),
    remove: async (u, id) => void calls.push(`${name}:remove:${u}:${id}`),
    reconcile: async (u, items) => void calls.push(`${name}:reconcile:${u}:${items.length}`),
  });
  const router = new CalendarProviderRouter({
    providers: { google: make("google"), apple: make("apple") },
    chosen: async () => chosen,
  });
  return { router, calls };
}

const noop = async () => {};

describe("calendar choice", () => {
  it("defaults to none", () => {
    expect(SETTINGS["sync.calendar_providers"].default).toEqual([]);
  });

  it.each([
    [["google"], ["google:upsert:u1:task-1"]],
    [["apple"], ["apple:upsert:u1:task-1"]],
    [
      ["google", "apple"],
      ["google:upsert:u1:task-1", "apple:upsert:u1:task-1"],
    ],
    [[], []],
    [["apple", "apple"], ["apple:upsert:u1:task-1"]],
  ] as [CalendarProvider[], string[]][])(
    "upsert with %j reaches only %j",
    async (chosen, expected) => {
      const { router, calls } = setup(chosen);
      await router.upsert("u1", ITEM, NOW);
      expect(calls).toEqual(expected);
    },
  );

  it("remove and reconcile follow the same choice", async () => {
    const { router, calls } = setup(["apple"]);
    await router.remove("u1", "task-1", NOW);
    await router.reconcile("u1", [ITEM], NOW);
    expect(calls).toEqual(["apple:remove:u1:task-1", "apple:reconcile:u1:1"]);
  });

  it("one failing provider does not stop the other and the error is reported", async () => {
    const calls: string[] = [];
    const router = new CalendarProviderRouter({
      providers: {
        google: {
          upsert: async () => {
            throw new Error("boom");
          },
          remove: noop,
          reconcile: noop,
        },
        apple: { upsert: async () => void calls.push("apple"), remove: noop, reconcile: noop },
      },
      chosen: async () => ["google", "apple"],
    });
    await expect(router.upsert("u1", ITEM, NOW)).rejects.toThrow("boom");
    expect(calls).toEqual(["apple"]);
  });

  it("a chosen provider that is not configured is skipped", async () => {
    const calls: string[] = [];
    const router = new CalendarProviderRouter({
      providers: {
        google: { upsert: async () => void calls.push("g"), remove: noop, reconcile: noop },
      },
      chosen: async () => ["google", "apple"],
    });
    await router.upsert("u1", ITEM, NOW);
    expect(calls).toEqual(["g"]);
  });
});
