import { describe, expect, it } from "vitest";
import { buildWeeklyLimitPlan } from "../src/weekly-plan";

const cases = [
  {
    name: "even split",
    input: { cycleLimitVnd: 4_000_000, weeks: 4, roundingVnd: 1000 },
    expected: [1_000_000, 1_000_000, 1_000_000, 1_000_000],
  },
  {
    name: "remainder goes to last week",
    input: { cycleLimitVnd: 1_000_500, weeks: 3, roundingVnd: 1000 },
    expected: [333_000, 333_000, 334_500],
  },
  {
    name: "single week takes everything",
    input: { cycleLimitVnd: 1_234_567, weeks: 1, roundingVnd: 1000 },
    expected: [1_234_567],
  },
  {
    name: "zero limit",
    input: { cycleLimitVnd: 0, weeks: 4, roundingVnd: 1000 },
    expected: [0, 0, 0, 0],
  },
  {
    name: "limit below rounding step",
    input: { cycleLimitVnd: 999, weeks: 3, roundingVnd: 1000 },
    expected: [0, 0, 999],
  },
  {
    name: "rounding of 1 is exact floor",
    input: { cycleLimitVnd: 10, weeks: 3, roundingVnd: 1 },
    expected: [3, 3, 4],
  },
  {
    name: "custom rounding 500",
    input: { cycleLimitVnd: 1_000_000, weeks: 3, roundingVnd: 500 },
    expected: [333_000, 333_000, 334_000],
  },
];

describe("buildWeeklyLimitPlan", () => {
  it.each(cases)("$name", ({ input, expected }) => {
    const plan = buildWeeklyLimitPlan(input);
    expect(plan).toEqual(expected);
    expect(plan.reduce((a, b) => a + b, 0)).toBe(input.cycleLimitVnd);
  });

  it.each([
    { name: "zero weeks", input: { cycleLimitVnd: 1000, weeks: 0, roundingVnd: 1000 } },
    { name: "fractional weeks", input: { cycleLimitVnd: 1000, weeks: 1.5, roundingVnd: 1000 } },
    { name: "zero rounding", input: { cycleLimitVnd: 1000, weeks: 2, roundingVnd: 0 } },
    { name: "negative limit", input: { cycleLimitVnd: -1, weeks: 2, roundingVnd: 1000 } },
    { name: "fractional limit", input: { cycleLimitVnd: 10.5, weeks: 2, roundingVnd: 1000 } },
  ])("rejects $name", ({ input }) => {
    expect(() => buildWeeklyLimitPlan(input)).toThrow(RangeError);
  });
});
