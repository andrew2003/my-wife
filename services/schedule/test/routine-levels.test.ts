import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import type { EventEnvelope } from "@my-wife/contracts";
import { createApp } from "../src/index";
import { buildStarterRoutines, resolveRoutineLevel } from "../src/routines";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const H = { "x-user-id": "u1" };

async function setup(settings: Record<string, unknown> = {}, nowIso = "2026-11-26T03:00:00.000Z") {
  const events: EventEnvelope[] = [];
  const app = await createApp(config, {
    publish: (e: EventEnvelope) => void events.push(e),
    readSettings: async () => settings,
    now: () => new Date(nowIso),
  });
  await app.inject({
    method: "POST",
    url: "/weeks",
    headers: H,
    payload: { firstDay: "2026-11-23" },
  });
  return { app, events, settings };
}

describe("starter defaults", () => {
  it("sets sleep and meals to track and wake-up to remind", () => {
    const levels = Object.fromEntries(buildStarterRoutines({}).map((r) => [r.id, r.level]));
    expect(levels).toEqual({
      sleep: "track",
      wake: "remind",
      breakfast: "track",
      lunch: "track",
      dinner: "track",
    });
  });

  it("uses the default meal windows and lets settings change them", () => {
    const by = (raw: Record<string, unknown>) =>
      Object.fromEntries(buildStarterRoutines(raw).map((r) => [r.id, r.window]));
    expect(by({})).toMatchObject({
      breakfast: { from: "06:30", to: "08:00", durationMinutes: 20 },
      lunch: { from: "11:30", to: "13:30", durationMinutes: 30 },
      dinner: { from: "18:30", to: "20:00", durationMinutes: 30 },
    });
    expect(
      by({ "routine.meal.dinner_window": { from: "19:00", to: "21:00", durationMinutes: 45 } })
        .dinner,
    ).toEqual({ from: "19:00", to: "21:00", durationMinutes: 45 });
  });

  it("prefers routine.<id>.level over the group key and falls back to it", () => {
    const raw = { "routine.meals.level": "remind", "routine.dinner.level": "commit" };
    expect(resolveRoutineLevel(raw, "dinner", "routine.meals.level")).toBe("commit");
    expect(resolveRoutineLevel(raw, "lunch", "routine.meals.level")).toBe("remind");
    expect(resolveRoutineLevel({}, "lunch", "routine.meals.level")).toBe("track");
    expect(
      resolveRoutineLevel({ "routine.lunch.level": "bogus" }, "lunch", "routine.meals.level"),
    ).toBe("track");
  });
});

// Defaults: UTC+7, lunch window 11:30-13:30 local = 04:30Z-06:30Z.
describe("routine at remind", () => {
  it("sends a message when its time arrives and records no check-in or fault", async () => {
    const { app, events } = await setup({ "routine.lunch.level": "remind" });
    await app.runRoutineJob(new Date("2026-11-24T04:29:00.000Z"));
    expect(events).toHaveLength(0);
    await app.runRoutineJob(new Date("2026-11-24T04:30:00.000Z"));
    const lunch = events.filter(
      (e) => e.type === "routine.reminder_due" && String(e.id).includes("-lunch-"),
    );
    expect(lunch).toHaveLength(1);
    expect(lunch[0]!.payload).toMatchObject({
      routine: "meal",
      messageKey: "routine.meal_reminder.lunch",
      params: { from: "11:30", to: "13:30", minutes: 30 },
    });
    expect(events.map((e) => e.type)).not.toContain("routine.checkin_recorded");
    expect(events.map((e) => e.type)).not.toContain("routine.late_detected");
    expect(events.map((e) => e.type).filter((t) => t.startsWith("fault."))).toEqual([]);
  });

  it("sends the reminder once however often the job runs", async () => {
    const { app, events } = await setup();
    await app.runRoutineJob(new Date("2026-11-24T04:30:00.000Z"));
    await app.runRoutineJob(new Date("2026-11-24T05:00:00.000Z"));
    expect(events.filter((e) => String(e.id).includes("-lunch-"))).toHaveLength(1);
  });

  it("sends nothing for a routine at off", async () => {
    const { app, events } = await setup({ "routine.meals.level": "off" });
    await app.runRoutineJob(new Date("2026-11-24T04:30:00.000Z"));
    expect(events).toHaveLength(0);
  });
});

// 2026-11-26 is a Thursday; the next Monday (week start) local midnight is 2026-11-29T17:00Z.
describe("lowering a routine from commit", () => {
  const change = (app: Awaited<ReturnType<typeof setup>>["app"], from: string, to: string) =>
    app.inject({
      method: "POST",
      url: "/routines/level-changes",
      headers: H,
      payload: { routineId: "wake", from, to },
    });
  const NOW = "2026-11-26T03:00:00.000Z";

  it("takes effect from next week and keeps commit until then", async () => {
    const { app, events, settings } = await setup({ "routine.wake.level": "remind" });
    settings["routine.wake.level"] = "remind";
    const res = await change(app, "commit", "remind");
    expect(res.statusCode).toBe(200);
    const changed = events.find((e) => e.type === "routine.level_changed")!;
    expect(changed.payload).toMatchObject({
      routine: "wake",
      from: "commit",
      to: "remind",
      effectiveFrom: "2026-11-29T17:00:00.000Z",
    });
    const view = async (at: string) =>
      (
        await app.inject({
          method: "GET",
          url: `/routines?at=${at}`,
          headers: H,
        })
      )
        .json()
        .data.routines.find((r: { id: string }) => r.id === "wake").level;
    expect(await view("2026-11-29T16:59:00.000Z")).toBe("commit");
    expect(await view("2026-11-29T17:00:00.000Z")).toBe("remind");
  });

  it("applies a raise at once", async () => {
    const { app, events } = await setup();
    await change(app, "remind", "commit");
    const changed = events.find((e) => e.type === "routine.level_changed")!;
    expect((changed.payload as { effectiveFrom: string }).effectiveFrom).toBeDefined();
    expect((changed.payload as { effectiveFrom: string }).effectiveFrom).toBe(NOW);
  });

  it("rejects an invalid request", async () => {
    const { app } = await setup();
    const res = await change(app, "commit", "bogus");
    expect(res.statusCode).toBe(400);
  });
});
