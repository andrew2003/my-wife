import { describe, expect, it } from "vitest";
import { SETTINGS } from "@my-wife/contracts";
import {
  DEFAULT_WEEKLY_PENALTY_SETTINGS,
  computeWeeklyPenalty,
  type WeeklyPenaltySettings,
} from "../src/weekly-penalty";

const THRESHOLDS = [
  { points: 6, amountVnd: 20_000 },
  { points: 12, amountVnd: 50_000 },
];
const settings = (over: Partial<WeeklyPenaltySettings> = {}): WeeklyPenaltySettings => ({
  thresholds: THRESHOLDS,
  weeklyCapVnd: 500_000,
  ...over,
});

const cases = [
  { name: "zero points", points: 0, carry: 0, s: settings(), raw: 0, issued: 0, carryOut: 0 },
  {
    name: "one below first threshold",
    points: 5,
    carry: 0,
    s: settings(),
    raw: 0,
    issued: 0,
    carryOut: 0,
  },
  {
    name: "exactly first threshold",
    points: 6,
    carry: 0,
    s: settings(),
    raw: 20_000,
    issued: 20_000,
    carryOut: 0,
  },
  {
    name: "7 points",
    points: 7,
    carry: 0,
    s: settings(),
    raw: 20_000,
    issued: 20_000,
    carryOut: 0,
  },
  {
    name: "one below second",
    points: 11,
    carry: 0,
    s: settings(),
    raw: 20_000,
    issued: 20_000,
    carryOut: 0,
  },
  {
    name: "12 points",
    points: 12,
    carry: 0,
    s: settings(),
    raw: 50_000,
    issued: 50_000,
    carryOut: 0,
  },
  {
    name: "far above highest",
    points: 99,
    carry: 0,
    s: settings(),
    raw: 50_000,
    issued: 50_000,
    carryOut: 0,
  },
  {
    name: "unsorted thresholds",
    points: 12,
    carry: 0,
    s: settings({ thresholds: [...THRESHOLDS].reverse() }),
    raw: 50_000,
    issued: 50_000,
    carryOut: 0,
  },
  {
    name: "cap 30k raw 50k",
    points: 12,
    carry: 0,
    s: settings({ weeklyCapVnd: 30_000 }),
    raw: 50_000,
    issued: 30_000,
    carryOut: 20_000,
  },
  {
    name: "raw equals cap",
    points: 12,
    carry: 0,
    s: settings({ weeklyCapVnd: 50_000 }),
    raw: 50_000,
    issued: 50_000,
    carryOut: 0,
  },
  {
    name: "one VND over cap",
    points: 12,
    carry: 0,
    s: settings({ weeklyCapVnd: 49_999 }),
    raw: 50_000,
    issued: 49_999,
    carryOut: 1,
  },
  {
    name: "carried debt added then capped",
    points: 6,
    carry: 20_000,
    s: settings({ weeklyCapVnd: 30_000 }),
    raw: 20_000,
    issued: 30_000,
    carryOut: 10_000,
  },
  {
    name: "carry alone is issued in a clean week",
    points: 0,
    carry: 20_000,
    s: settings(),
    raw: 0,
    issued: 20_000,
    carryOut: 0,
  },
  {
    name: "cap zero carries everything",
    points: 12,
    carry: 0,
    s: settings({ weeklyCapVnd: 0 }),
    raw: 50_000,
    issued: 0,
    carryOut: 50_000,
  },
  {
    name: "no thresholds",
    points: 50,
    carry: 0,
    s: settings({ thresholds: [] }),
    raw: 0,
    issued: 0,
    carryOut: 0,
  },
];

describe("computeWeeklyPenalty", () => {
  it.each(cases)("$name", ({ points, carry, s, raw, issued, carryOut }) => {
    expect(computeWeeklyPenalty({ points, carriedDebtVnd: carry }, s)).toEqual({
      rawPenaltyVnd: raw,
      issuedVnd: issued,
      carryOutVnd: carryOut,
    });
  });

  it("invalid inputs are treated as zero", () => {
    expect(computeWeeklyPenalty({ points: -3, carriedDebtVnd: 1.5 }, settings())).toEqual({
      rawPenaltyVnd: 0,
      issuedVnd: 0,
      carryOutVnd: 0,
    });
  });

  it("falls back to registry defaults for an invalid cap", () => {
    const r = computeWeeklyPenalty(
      { points: 12, carriedDebtVnd: 0 },
      settings({ weeklyCapVnd: -1 }),
    );
    expect(r.issuedVnd).toBe(Math.min(50_000, SETTINGS["penalty.weekly_cap_vnd"].default));
  });

  it("defaults come from the registry", () => {
    expect(DEFAULT_WEEKLY_PENALTY_SETTINGS).toEqual({
      thresholds: SETTINGS["fault.thresholds"].default,
      weeklyCapVnd: SETTINGS["penalty.weekly_cap_vnd"].default,
    });
  });
});
