import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { createApp } from "../src/index";
import { solarOccurrences, type SolarRecurrence } from "../src/recurrence";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const H = { "x-user-id": "u1" };

const rec = (pattern: SolarRecurrence["pattern"], exceptions: string[] = []): SolarRecurrence => ({
  id: "r1",
  calendar: "solar",
  pattern,
  exceptions,
});

describe("solarOccurrences (table-driven)", () => {
  const cases: {
    name: string;
    recurrence: SolarRecurrence;
    from: string;
    to: string;
    expected: string[];
  }[] = [
    {
      name: "weekly Monday and Thursday (0 is Sunday)",
      recurrence: rec({ type: "weekly", weekdays: [1, 4] }),
      from: "2026-11-23",
      to: "2026-11-29",
      expected: ["2026-11-23", "2026-11-26"],
    },
    {
      name: "weekly Sunday is 0 and lands on the last day of a Monday week",
      recurrence: rec({ type: "weekly", weekdays: [0] }),
      from: "2026-11-23",
      to: "2026-11-29",
      expected: ["2026-11-29"],
    },
    {
      name: "weekly with an exception drops that day",
      recurrence: rec({ type: "weekly", weekdays: [1, 4] }, ["2026-11-26"]),
      from: "2026-11-23",
      to: "2026-11-29",
      expected: ["2026-11-23"],
    },
    {
      name: "monthly day 15",
      recurrence: rec({ type: "monthly_day", day: 15 }),
      from: "2026-11-09",
      to: "2026-11-22",
      expected: ["2026-11-15"],
    },
    {
      name: "monthly day 31 is absent when the range misses the month end",
      recurrence: rec({ type: "monthly_day", day: 31 }),
      from: "2026-11-23",
      to: "2026-11-29",
      expected: [],
    },
    {
      name: "monthly day 31 clamps to 30 November",
      recurrence: rec({ type: "monthly_day", day: 31 }),
      from: "2026-11-24",
      to: "2026-11-30",
      expected: ["2026-11-30"],
    },
    {
      name: "monthly day 30 clamps to 28 February (non-leap year)",
      recurrence: rec({ type: "monthly_day", day: 30 }),
      from: "2027-02-22",
      to: "2027-02-28",
      expected: ["2027-02-28"],
    },
    {
      name: "monthly day 29 clamps to 29 February (leap year)",
      recurrence: rec({ type: "monthly_day", day: 29 }),
      from: "2028-02-23",
      to: "2028-02-29",
      expected: ["2028-02-29"],
    },
    {
      name: "a range across a month change finds the next month",
      recurrence: rec({ type: "monthly_day", day: 1 }),
      from: "2026-11-30",
      to: "2026-12-06",
      expected: ["2026-12-01"],
    },
  ];
  it.each(cases)("$name", ({ recurrence, from, to, expected }) => {
    expect(solarOccurrences(recurrence, from, to)).toEqual(expected);
  });

  it("ignores lunar recurrences", () => {
    const lunar = { ...rec({ type: "lunar_day", day: 1 }), calendar: "lunar" } as never;
    expect(solarOccurrences(lunar, "2026-11-23", "2026-11-29")).toEqual([]);
  });
});

async function setup(now = "2026-11-23T08:00:00Z", settings: Record<string, unknown> = {}) {
  const app = await createApp(config, {
    now: () => new Date(now),
    readSettings: async () => settings,
  });
  const created = await app.inject({
    method: "POST",
    url: "/weeks",
    headers: H,
    payload: { firstDay: "2026-11-23" },
  });
  return { app, weekId: created.json().data.week.id as string };
}
const task = {
  title: "Gym",
  estimatedMinutes: 60,
  kind: "offline",
  monitoringProfile: "none",
};

async function tasksOn(app: Awaited<ReturnType<typeof setup>>["app"], day: string, h = H) {
  const res = await app.inject({ method: "GET", url: `/checklist?date=${day}`, headers: h });
  return res.json().data.tasks as Record<string, unknown>[];
}

describe("recurring instances when the week is planned", () => {
  it("creates instances on the right days, linked to the recurrence", async () => {
    const { app, weekId } = await setup();
    const created = await app.inject({
      method: "POST",
      url: "/recurrences",
      headers: H,
      payload: { calendar: "solar", pattern: { type: "weekly", weekdays: [1, 4] }, task },
    });
    expect(created.statusCode).toBe(200);
    const recId = created.json().data.recurrence.id as string;
    const res = await app.inject({
      method: "POST",
      url: `/weeks/${weekId}/plan`,
      headers: H,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.recurringTasks).toHaveLength(2);
    for (const [day, count] of [
      ["2026-11-23", 1],
      ["2026-11-24", 0],
      ["2026-11-26", 1],
    ] as const) {
      const tasks = await tasksOn(app, day);
      expect(tasks).toHaveLength(count);
      if (count) {
        expect(tasks[0]).toMatchObject({
          title: "Gym",
          state: "planned",
          parentRecurrenceId: recId,
        });
      }
    }
  });

  it("does not duplicate instances when the week is planned twice", async () => {
    const { app, weekId } = await setup();
    await app.inject({
      method: "POST",
      url: "/recurrences",
      headers: H,
      payload: { calendar: "solar", pattern: { type: "weekly", weekdays: [1] }, task },
    });
    for (let i = 0; i < 2; i += 1) {
      await app.inject({ method: "POST", url: `/weeks/${weekId}/plan`, headers: H, payload: {} });
    }
    expect(await tasksOn(app, "2026-11-23")).toHaveLength(1);
  });

  it("skips exception days and days before the user's local today", async () => {
    // 2026-11-25 23:00 UTC is already 26 November in Ho Chi Minh City.
    const { app, weekId } = await setup("2026-11-25T23:00:00Z", {
      "calendar.time_zone": "Asia/Ho_Chi_Minh",
    });
    await app.inject({
      method: "POST",
      url: "/recurrences",
      headers: H,
      payload: {
        calendar: "solar",
        pattern: { type: "weekly", weekdays: [1, 3, 4, 5] },
        exceptions: ["2026-11-27"],
        task,
      },
    });
    await app.inject({ method: "POST", url: `/weeks/${weekId}/plan`, headers: H, payload: {} });
    const days: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const day = `2026-11-${23 + i}`;
      if ((await tasksOn(app, day)).length) days.push(day);
    }
    expect(days).toEqual(["2026-11-26"]);
  });

  it("keeps recurrences private to their user and rejects lunar or invalid input", async () => {
    const { app, weekId } = await setup();
    const bad = [
      { calendar: "lunar", pattern: { type: "lunar_day", day: 1 }, task },
      { calendar: "solar", pattern: { type: "weekly", weekdays: [7] }, task },
      { calendar: "solar", pattern: { type: "weekly", weekdays: [1] } },
    ];
    for (const payload of bad) {
      const res = await app.inject({ method: "POST", url: "/recurrences", headers: H, payload });
      expect(res.statusCode).toBe(400);
    }
    await app.inject({
      method: "POST",
      url: "/recurrences",
      headers: { "x-user-id": "u2" },
      payload: { calendar: "solar", pattern: { type: "weekly", weekdays: [1] }, task },
    });
    await app.inject({ method: "POST", url: `/weeks/${weekId}/plan`, headers: H, payload: {} });
    expect(await tasksOn(app, "2026-11-23")).toHaveLength(0);
  });
});
