import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { createApp } from "../src/index";
import { LunarRangeError, lunarToSolar, solarToLunar } from "../src/lunar";
import { lunarOccurrences, type LunarRecurrence } from "../src/recurrence";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const H = { "x-user-id": "u1" };

/** Fixture table: well-known lunar dates, including the leap months of 2020, 2023 and 2025. */
const FIXTURES: {
  name: string;
  solar: string;
  lunar: { year: number; month: number; day: number; leap: boolean };
}[] = [
  { name: "Tet 2023", solar: "2023-01-22", lunar: { year: 2023, month: 1, day: 1, leap: false } },
  { name: "Tet 2024", solar: "2024-02-10", lunar: { year: 2024, month: 1, day: 1, leap: false } },
  {
    name: "day before Tet 2024 ends the old year",
    solar: "2024-02-09",
    lunar: { year: 2023, month: 12, day: 30, leap: false },
  },
  {
    name: "2023 month 2",
    solar: "2023-02-20",
    lunar: { year: 2023, month: 2, day: 1, leap: false },
  },
  {
    name: "2023 leap month 2, 1st",
    solar: "2023-03-22",
    lunar: { year: 2023, month: 2, day: 1, leap: true },
  },
  {
    name: "2023 month 3 after the leap",
    solar: "2023-04-20",
    lunar: { year: 2023, month: 3, day: 1, leap: false },
  },
  {
    name: "2020 month 4",
    solar: "2020-04-23",
    lunar: { year: 2020, month: 4, day: 1, leap: false },
  },
  {
    name: "2020 leap month 4, 1st",
    solar: "2020-05-23",
    lunar: { year: 2020, month: 4, day: 1, leap: true },
  },
  {
    name: "2025 month 6",
    solar: "2025-06-25",
    lunar: { year: 2025, month: 6, day: 1, leap: false },
  },
  {
    name: "2025 leap month 6, 1st",
    solar: "2025-07-25",
    lunar: { year: 2025, month: 6, day: 1, leap: true },
  },
  {
    name: "2025 leap month 6, 15th",
    solar: "2025-08-08",
    lunar: { year: 2025, month: 6, day: 15, leap: true },
  },
];

describe("solarToLunar and lunarToSolar (table-driven fixtures)", () => {
  it.each(FIXTURES)("solar to lunar: $name", ({ solar, lunar }) => {
    expect(solarToLunar(solar)).toEqual(lunar);
  });
  it.each(FIXTURES)("lunar to solar: $name", ({ solar, lunar }) => {
    expect(lunarToSolar(lunar)).toBe(solar);
  });
  it("round-trips every day of 2023 to 2025", () => {
    for (let t = Date.UTC(2023, 0, 1); t < Date.UTC(2026, 0, 1); t += 86_400_000) {
      const solar = new Date(t).toISOString().slice(0, 10);
      expect(lunarToSolar(solarToLunar(solar))).toBe(solar);
    }
  });
  it("maps day 30 of a 29-day month to the last day of that month", () => {
    // Lunar month 3 of 2023 has 29 days: it runs 2023-04-20 to 2023-05-18.
    expect(lunarToSolar({ year: 2023, month: 3, day: 30, leap: false })).toBe("2023-05-18");
  });
  it("refuses a leap month that does not exist", () => {
    expect(() => lunarToSolar({ year: 2023, month: 5, day: 1, leap: true })).toThrow(
      LunarRangeError,
    );
  });
  it("refuses dates outside the fixture year range with a typed error", () => {
    expect(() => solarToLunar("1800-01-01")).toThrow(LunarRangeError);
    expect(() => solarToLunar("2300-01-01")).toThrow(LunarRangeError);
    expect(() => lunarToSolar({ year: 1500, month: 1, day: 1, leap: false })).toThrow(
      LunarRangeError,
    );
  });
});

const rec = (
  pattern: LunarRecurrence["pattern"],
  exceptions: string[] = [],
  options: Partial<LunarRecurrence> = {},
): LunarRecurrence => ({ id: "r1", calendar: "lunar", pattern, exceptions, ...options });

describe("lunarOccurrences (table-driven)", () => {
  const cases: {
    name: string;
    recurrence: LunarRecurrence;
    from: string;
    to: string;
    expected: string[];
  }[] = [
    {
      name: "the 1st of every lunar month includes the leap month of 2023",
      recurrence: rec({ type: "lunar_day", day: 1 }),
      from: "2023-01-01",
      to: "2023-05-31",
      expected: ["2023-01-22", "2023-02-20", "2023-03-22", "2023-04-20", "2023-05-19"],
    },
    {
      name: "the 15th of every lunar month includes the leap month of 2025",
      recurrence: rec({ type: "lunar_day", day: 15 }),
      from: "2025-06-01",
      to: "2025-09-30",
      expected: ["2025-06-10", "2025-07-09", "2025-08-08", "2025-09-06"],
    },
    {
      name: "an anniversary on the 1st of month 2 skips the leap month by default",
      recurrence: rec({ type: "lunar_day", day: 1, month: 2 }),
      from: "2023-01-01",
      to: "2023-12-31",
      expected: ["2023-02-20"],
    },
    {
      name: "an anniversary can opt in to the leap month as well",
      recurrence: rec({ type: "lunar_day", day: 1, month: 2 }, [], { includeLeapMonth: true }),
      from: "2023-01-01",
      to: "2023-12-31",
      expected: ["2023-02-20", "2023-03-22"],
    },
    {
      name: "day 30 in a 29-day month falls on the last day of the month",
      recurrence: rec({ type: "lunar_day", day: 30, month: 3 }),
      from: "2023-05-01",
      to: "2023-05-31",
      expected: ["2023-05-18"],
    },
    {
      name: "an exception drops that day",
      recurrence: rec({ type: "lunar_day", day: 1 }, ["2023-03-22"]),
      from: "2023-03-01",
      to: "2023-04-30",
      expected: ["2023-04-20"],
    },
    {
      name: "a solar recurrence is ignored",
      recurrence: { ...rec({ type: "lunar_day", day: 1 }), calendar: "solar" } as never,
      from: "2023-03-01",
      to: "2023-04-30",
      expected: [],
    },
  ];
  it.each(cases)("$name", ({ recurrence, from, to, expected }) => {
    expect(lunarOccurrences(recurrence, from, to)).toEqual(expected);
  });
});

const task = { title: "Altar", estimatedMinutes: 30, kind: "offline", monitoringProfile: "none" };

describe("lunar recurrence through the API", () => {
  it("plans the instance on the solar date of the leap month's 1st", async () => {
    const app = await createApp(config, {
      now: () => new Date("2023-03-20T01:00:00Z"),
      readSettings: async () => ({}),
    });
    const week = await app.inject({
      method: "POST",
      url: "/weeks",
      headers: H,
      payload: { firstDay: "2023-03-20" },
    });
    const weekId = week.json().data.week.id as string;
    const created = await app.inject({
      method: "POST",
      url: "/recurrences",
      headers: H,
      payload: { calendar: "lunar", pattern: { type: "lunar_day", day: 1 }, task },
    });
    expect(created.statusCode).toBe(200);
    const res = await app.inject({
      method: "POST",
      url: `/weeks/${weekId}/plan`,
      headers: H,
      payload: {},
    });
    const days = (res.json().data.recurringTasks as { day: string }[]).map((t) => t.day);
    expect(days).toEqual(["2023-03-22"]);
  });

  it("rejects a calendar that does not match the pattern", async () => {
    const app = await createApp(config, { readSettings: async () => ({}) });
    for (const payload of [
      { calendar: "solar", pattern: { type: "lunar_day", day: 1 }, task },
      { calendar: "lunar", pattern: { type: "weekly", weekdays: [1] }, task },
    ]) {
      const res = await app.inject({ method: "POST", url: "/recurrences", headers: H, payload });
      expect(res.statusCode).toBe(400);
    }
  });
});
