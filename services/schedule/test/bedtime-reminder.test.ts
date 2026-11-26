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
  const run = (at: string) => app.runSleepJob(new Date(at));
  const state = async (night = "2026-11-23") =>
    (await app.inject({ method: "GET", url: `/sleep/night?date=${night}`, headers: H })).json().data
      ?.night?.state as string | undefined;
  const reminders = () => events.filter((e) => e.type === "routine.reminder_due");
  return { app, events, run, state, reminders };
}

// Defaults: bedtime 23:00 local (UTC+7 = 16:00Z), lead 15 minutes.
describe("bedtime reminder through sleep_night", () => {
  it("sends the reminder at bedtime minus the lead time and moves to bedtime_reminded", async () => {
    const { run, state, reminders } = await setup();
    await run("2026-11-23T15:44:00.000Z");
    expect(reminders()).toHaveLength(0);
    await run("2026-11-23T15:45:00.000Z");
    expect(reminders()).toHaveLength(1);
    expect(reminders()[0]!.payload).toMatchObject({
      routine: "sleep",
      dueAt: "2026-11-23T15:45:00.000Z",
      messageKey: "routine.bedtime_reminder",
    });
    expect(await state()).toBe("bedtime_reminded");
  });

  it("sends the reminder once however often the job runs", async () => {
    const { run, reminders } = await setup();
    await run("2026-11-23T15:45:00.000Z");
    await run("2026-11-23T15:50:00.000Z");
    await run("2026-11-23T15:59:00.000Z");
    expect(reminders()).toHaveLength(1);
  });

  it("moves to sleeping when bedtime is reached", async () => {
    const { run, state, reminders } = await setup();
    await run("2026-11-23T15:45:00.000Z");
    await run("2026-11-23T16:00:00.000Z");
    expect(await state()).toBe("sleeping");
    expect(reminders()).toHaveLength(1);
  });

  it("reads bedtime, lead time and time zone from settings", async () => {
    const { run, reminders } = await setup({
      "routine.sleep.start": "22:00",
      "routine.bedtime_lead_minutes": 30,
      "calendar.time_zone": "UTC",
    });
    await run("2026-11-23T21:29:00.000Z");
    expect(reminders()).toHaveLength(0);
    await run("2026-11-23T21:30:00.000Z");
    expect(reminders()).toHaveLength(1);
  });

  it("does nothing when the sleep routine is off", async () => {
    const { run, state, reminders } = await setup({ "routine.sleep.level": "off" });
    await run("2026-11-23T16:30:00.000Z");
    expect(reminders()).toHaveLength(0);
    expect(await state()).toBeUndefined();
  });

  it("retries a failed publish on the next run", async () => {
    let fail = true;
    const events: EventEnvelope[] = [];
    const app = await createApp(config, {
      publish: (e: EventEnvelope) => {
        if (fail) throw new Error("bus down");
        events.push(e);
      },
      readSettings: async () => ({}),
    });
    await app.inject({
      method: "POST",
      url: "/weeks",
      headers: H,
      payload: { firstDay: "2026-11-23" },
    });
    const first = await app.runSleepJob(new Date("2026-11-23T15:46:00.000Z"));
    expect(first.failed).toEqual(["u1"]);
    fail = false;
    await app.runSleepJob(new Date("2026-11-23T15:47:00.000Z"));
    expect(events.filter((e) => e.type === "routine.reminder_due")).toHaveLength(1);
  });

  it("keeps each night separate", async () => {
    const { run, state, reminders } = await setup();
    await run("2026-11-23T15:45:00.000Z");
    await run("2026-11-24T15:45:00.000Z");
    expect(reminders()).toHaveLength(2);
    expect(await state("2026-11-24")).toBe("bedtime_reminded");
  });

  it("does not read the system clock", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/sleep.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/new Date\(\)|Date\.now\(\)/);
  });
});
