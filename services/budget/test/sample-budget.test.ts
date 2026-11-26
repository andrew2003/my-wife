import { describe, expect, it } from "vitest";
import { allocateByRatio, buildSampleBudget, DEFAULT_SAMPLE_TEMPLATE } from "../src/sample-budget";

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("allocateByRatio", () => {
  const cases = [
    {
      name: "even split",
      total: 9000,
      ratios: [5000, 3000, 2000],
      unit: 1000,
      expected: [4000, 3000, 2000],
    },
    {
      name: "remainder units go to the largest remainders",
      total: 10000,
      ratios: [3333, 3333, 3334],
      unit: 1000,
      expected: [3000, 3000, 4000],
    },
    { name: "unit of 1 VND", total: 10, ratios: [3333, 3333, 3334], unit: 1, expected: [3, 3, 4] },
    {
      name: "total below one unit goes to the largest ratio",
      total: 600,
      ratios: [2000, 8000],
      unit: 1000,
      expected: [0, 600],
    },
    {
      name: "total not a multiple of the unit",
      total: 10500,
      ratios: [5000, 5000],
      unit: 1000,
      expected: [5500, 5000],
    },
    { name: "zero total", total: 0, ratios: [5000, 5000], unit: 1000, expected: [0, 0] },
    {
      name: "zero ratio gets nothing",
      total: 10000,
      ratios: [10000, 0],
      unit: 1000,
      expected: [10000, 0],
    },
  ];
  it.each(cases)("$name", ({ total, ratios, unit, expected }) => {
    const result = allocateByRatio(total, ratios, unit);
    expect(result).toEqual(expected);
    expect(sum(result)).toBe(total);
  });

  it.each([
    { name: "negative total", total: -1, ratios: [10000], unit: 1000 },
    { name: "fractional total", total: 1.5, ratios: [10000], unit: 1000 },
    { name: "zero unit", total: 1000, ratios: [10000], unit: 0 },
    { name: "ratios not summing to 10000", total: 1000, ratios: [5000], unit: 1000 },
  ])("rejects $name", ({ total, ratios, unit }) => {
    expect(() => allocateByRatio(total, ratios, unit)).toThrow(RangeError);
  });
});

describe("buildSampleBudget", () => {
  it("splits the standard category set by the sample ratios", () => {
    const draft = buildSampleBudget({ totalVnd: 10_000_000, roundingVnd: 1000 });
    expect(draft.categories.map((c) => c.key)).toEqual(DEFAULT_SAMPLE_TEMPLATE.map((c) => c.key));
    expect(draft.categories).toHaveLength(11);
    expect(draft.categories.find((c) => c.key === "food")?.cycleLimitVnd).toBe(2_700_000);
  });

  it.each([10_000_000, 12_345_678, 1, 999, 0, 7_777_777])(
    "limits sum to %i exactly",
    (totalVnd) => {
      const draft = buildSampleBudget({ totalVnd, roundingVnd: 1000 });
      expect(sum(draft.categories.map((c) => c.cycleLimitVnd))).toBe(totalVnd);
    },
  );

  it("honors a custom template and rounding", () => {
    const draft = buildSampleBudget({
      totalVnd: 1_000_000,
      roundingVnd: 10_000,
      template: [
        { ...DEFAULT_SAMPLE_TEMPLATE[0]!, ratioBp: 6000 },
        { ...DEFAULT_SAMPLE_TEMPLATE[1]!, ratioBp: 4000 },
      ],
    });
    expect(draft.categories.map((c) => c.cycleLimitVnd)).toEqual([600_000, 400_000]);
  });

  it("default template is valid: unique non-reserved short codes, ratios sum to 10000", () => {
    const codes = DEFAULT_SAMPLE_TEMPLATE.map((c) => c.shortCode);
    expect(new Set(codes).size).toBe(codes.length);
    for (const reserved of ["DC", "PH", "MW", "F"]) expect(codes).not.toContain(reserved);
    expect(sum(DEFAULT_SAMPLE_TEMPLATE.map((c) => c.ratioBp))).toBe(10_000);
  });
});
