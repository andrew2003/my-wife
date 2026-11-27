import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { createApp } from "../src/index";
import { dayProfileOf, placeFlexibleBlock, planRoutineBlocks } from "../src/routine-blocks";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const H = { "x-user-id": "u1" };

type Block = { day: string; id: string; start?: string; end?: string; placed: boolean };

async function setup(settings: Record<string, unknown> = {}) {
  const app = await createApp(config, {
    publish: () => undefined,
    readSettings: async () => settings,
    now: () => new Date("2026-11-23T01:00:00.000Z"),
  });
  const week = (
    await app.inject({
      method: "POST",
      url: "/weeks",
      headers: H,
      payload: { firstDay: "2026-11-23" },
    })
  ).json().data.week;
  return { app, week };
}

const addTask = (
  app: Awaited<ReturnType<typeof setup>>["app"],
  day: string,
  start: string,
  end: string,
) =>
  app.inject({
    method: "POST",
    url: "/tasks",
    headers: H,
    payload: {
      title: "Work",
      day,
      kind: "desk",
      estimatedMinutes: 60,
      monitoringProfile: "none",
      window: { start, end },
    },
  });

const planWeek = (app: Awaited<ReturnType<typeof setup>>["app"], id: string) =>
  app.inject({ method: "POST", url: `/weeks/${id}/plan`, headers: H, payload: {} });

describe("flexible block placement", () => {
  it("places a block in the first gap of its window that fits", () => {
    const placed = placeFlexibleBlock({
      window: { from: "11:30", to: "13:30" },
      durationMinutes: 30,
      busy: [{ start: "11:00", end: "12:15" }],
    });
    expect(placed).toEqual({ start: "12:15", end: "12:45" });
  });

  it("returns null when no gap is long enough", () => {
    expect(
      placeFlexibleBlock({
        window: { from: "11:30", to: "13:30" },
        durationMinutes: 30,
        busy: [{ start: "11:00", end: "14:00" }],
      }),
    ).toBeNull();
  });
});

describe("day profiles", () => {
  it("uses weekend days from settings and defaults weekend to weekday times", () => {
    expect(dayProfileOf({}, "2026-11-28")).toBe("weekend");
    expect(dayProfileOf({}, "2026-11-23")).toBe("weekday");
    expect(dayProfileOf({ "routine.weekend_days": ["friday"] }, "2026-11-27")).toBe("weekend");
    const weekend = planRoutineBlocks(
      { "routine.weekend.meal.lunch_window": { from: "12:00", to: "14:00", durationMinutes: 45 } },
      "2026-11-28",
      [],
    );
    expect(weekend.blocks.find((b) => b.id === "lunch")).toMatchObject({
      start: "12:00",
      end: "12:45",
    });
    const weekday = planRoutineBlocks({}, "2026-11-23", []);
    expect(weekday.blocks.find((b) => b.id === "lunch")).toMatchObject({
      start: "11:30",
      end: "12:00",
    });
  });

  it("holds sleep as a fixed block and leaves out routines set to off", () => {
    const plan = planRoutineBlocks({ "routine.meals.level": "off" }, "2026-11-23", []);
    expect(plan.blocks.map((b) => b.id)).toEqual(["sleep"]);
    expect(plan.blocks[0]).toMatchObject({ blockKind: "fixed", start: "23:00", end: "06:00" });
  });
});

describe("weekly plan", () => {
  it("places a flexible lunch block in the gap between tasks", async () => {
    const { app, week } = await setup();
    await addTask(app, "2026-11-23", "11:00", "12:10");
    await addTask(app, "2026-11-23", "12:40", "15:00");
    const data = (await planWeek(app, week.id)).json().data;
    const lunch = (data.routineBlocks as Block[]).find(
      (b) => b.day === "2026-11-23" && b.id === "lunch",
    );
    expect(lunch).toMatchObject({ start: "12:10", end: "12:40", placed: true });
    expect(data.overloaded).toBe(false);
  });

  it("shows overloaded when routine hours exceed the available time", async () => {
    const { app, week } = await setup({
      "routine.wake.time": "07:00",
      "routine.sleep.start": "09:00",
      "routine.meal.lunch_window": { from: "07:00", to: "09:00", durationMinutes: 90 },
      "routine.meal.breakfast_window": { from: "07:00", to: "09:00", durationMinutes: 60 },
    });
    const data = (await planWeek(app, week.id)).json().data;
    expect(data).toMatchObject({ overloaded: true, routineOverloaded: true });
    expect(data.routineOverloadMinutes).toBeGreaterThan(0);
  });

  it("shows overloaded when a flexible block has no gap left", async () => {
    const { app, week } = await setup();
    await addTask(app, "2026-11-23", "11:00", "14:00");
    const data = (await planWeek(app, week.id)).json().data;
    expect(data.overloaded).toBe(true);
    const lunch = (data.routineBlocks as Block[]).find(
      (b) => b.id === "lunch" && b.day === "2026-11-23",
    );
    expect(lunch?.placed).toBe(false);
  });
});
