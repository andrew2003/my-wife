import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import type { EventEnvelope } from "@my-wife/contracts";
import { createApp } from "../src/index";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const H = { "x-user-id": "u1" };

async function setup(settings: Record<string, unknown> = {}) {
  const events: EventEnvelope[] = [];
  const app = await createApp(config, {
    publish: (e: EventEnvelope) => void events.push(e),
    readSettings: async () => settings,
  });
  await app.inject({
    method: "POST",
    url: "/weeks",
    headers: H,
    payload: { firstDay: "2026-11-23" },
  });
  const activity = async (at: string) =>
    (
      await app.inject({
        method: "POST",
        url: "/sleep/activity",
        headers: H,
        payload: { at },
      })
    ).json();
  const lateReminders = () =>
    events.filter(
      (e) =>
        e.type === "routine.reminder_due" &&
        (e.payload as { messageKey: string }).messageKey === "routine.late_night_reminder",
    );
  const night = async (date = "2026-11-23") =>
    (await app.inject({ method: "GET", url: `/sleep/night?date=${date}`, headers: H })).json().data
      ?.night;
  return { app, events, activity, lateReminders, night };
}

// Defaults: bedtime 23:00 local (UTC+7 = 16:00Z).
describe("late-night web activity after bedtime", () => {
  it.each([
    ["before the lead time", "2026-11-23T15:00:00.000Z", false],
    ["during the lead time, before bedtime", "2026-11-23T15:50:00.000Z", false],
    ["at bedtime", "2026-11-23T16:00:00.000Z", true],
    ["after bedtime", "2026-11-23T17:30:00.000Z", true],
  ])("activity %s labels late_night: %s", async (_n, at, labelled) => {
    const { activity, lateReminders } = await setup();
    const res = await activity(at);
    expect(res.data.labelled).toBe(labelled);
    expect(lateReminders()).toHaveLength(labelled ? 1 : 0);
  });

  it("sends one reminder and the soft label with quick reasons, however often activity repeats", async () => {
    const { activity, lateReminders, night, events } = await setup();
    const first = await activity("2026-11-23T16:10:00.000Z");
    const second = await activity("2026-11-23T16:40:00.000Z");
    await activity("2026-11-23T17:10:00.000Z");
    expect(first.data).toMatchObject({
      labelled: true,
      label: "late_night",
      quickReasons: ["urgent_work", "cannot_sleep"],
    });
    expect(second.data.labelled).toBe(true);
    expect(lateReminders()).toHaveLength(1);
    expect(lateReminders()[0]!.payload).toMatchObject({ routine: "sleep" });
    expect((await night()).state).toBe("sleeping");
    expect((await night()).lateNightLabelledAt).toBe("2026-11-23T16:10:00.000Z");
    expect(events.some((e) => e.type === "routine.late_detected")).toBe(false);
    expect(events.some((e) => e.type.startsWith("fault."))).toBe(false);
  });

  // Night of Mon 2026-11-23, bedtime 16:00Z; wake default 06:00 local = 23:00Z.
  it.each([
    ["before wake time (05:59 local)", {}, "2026-11-23T22:59:00.000Z", true],
    ["at wake time (06:00 local)", {}, "2026-11-23T23:00:00.000Z", false],
    ["next morning 07:00 local", {}, "2026-11-24T00:00:00.000Z", false],
    [
      "later wake setting, 07:00 local",
      { "routine.wake.time": "08:00" },
      "2026-11-24T00:00:00.000Z",
      true,
    ],
    [
      "weekend wake override on Saturday (night of Friday), 07:30 local",
      { "routine.weekend.wake_time": "09:00" },
      "2026-11-28T00:30:00.000Z",
      true,
    ],
  ])("activity %s: labelled %s", async (_n, settings, at, labelled) => {
    const friday = at.startsWith("2026-11-28");
    const { activity, lateReminders } = await setup(settings);
    if (friday) {
      // Friday night bedtime 16:00Z on 2026-11-27 needs its own week.
      await activity("2026-11-27T16:10:00.000Z");
    }
    const before = lateReminders().length;
    const res = await activity(at);
    expect(res.data.labelled).toBe(labelled);
    expect(lateReminders().length - before).toBe(!friday && labelled ? 1 : 0);
  });

  it("follows the bedtime setting", async () => {
    const { activity, lateReminders } = await setup({ "routine.sleep.start": "22:00" });
    await activity("2026-11-23T15:30:00.000Z");
    expect(lateReminders()).toHaveLength(1);
  });

  it("does nothing when the sleep routine is off", async () => {
    const { activity, lateReminders } = await setup({ "routine.sleep.level": "off" });
    const res = await activity("2026-11-23T17:00:00.000Z");
    expect(res.data.labelled).toBe(false);
    expect(lateReminders()).toHaveLength(0);
  });

  it("rejects missing user and bad time", async () => {
    const { app } = await setup();
    expect(
      (await app.inject({ method: "POST", url: "/sleep/activity", payload: { at: "x" } }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/sleep/activity",
          headers: H,
          payload: { at: "nope" },
        })
      ).statusCode,
    ).toBe(400);
  });
});
