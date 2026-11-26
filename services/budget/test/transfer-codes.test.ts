import { describe, expect, it } from "vitest";
import {
  issueCycleCategoryCode,
  issueFundingCode,
  issuePenaltyCode,
  issuePlannedCode,
  matchTransferCode,
  normalizeMemo,
} from "../src/transfer-codes";

describe("issuePlannedCode", () => {
  const cases = [
    {
      name: "spec example",
      input: { cycleSequence: 7, weekIndex: 2, categoryShortCode: "AN" },
      existing: [],
      expected: "MW-C07W2-AN-01",
    },
    {
      name: "next free number",
      input: { cycleSequence: 7, weekIndex: 2, categoryShortCode: "AN" },
      existing: ["MW-C07W2-AN-01", "MW-C07W2-AN-02"],
      expected: "MW-C07W2-AN-03",
    },
    {
      name: "other week does not count",
      input: { cycleSequence: 7, weekIndex: 3, categoryShortCode: "AN" },
      existing: ["MW-C07W2-AN-01"],
      expected: "MW-C07W3-AN-01",
    },
    {
      name: "lowercase short code is uppercased",
      input: { cycleSequence: 12, weekIndex: 1, categoryShortCode: "an" },
      existing: [],
      expected: "MW-C12W1-AN-01",
    },
    {
      name: "three digit cycle sequence",
      input: { cycleSequence: 123, weekIndex: 1, categoryShortCode: "AN" },
      existing: [],
      expected: "MW-C123W1-AN-01",
    },
    {
      name: "uses max plus one, never reuses a gap",
      input: { cycleSequence: 1, weekIndex: 1, categoryShortCode: "AN" },
      existing: ["MW-C01W1-AN-05"],
      expected: "MW-C01W1-AN-06",
    },
  ];
  it.each(cases)("$name", ({ input, existing, expected }) => {
    expect(issuePlannedCode(input, existing)).toBe(expected);
  });

  it("is unique across many issues", () => {
    const issued: string[] = [];
    for (let i = 0; i < 120; i++) {
      issued.push(
        issuePlannedCode({ cycleSequence: 1, weekIndex: 1, categoryShortCode: "AN" }, issued),
      );
    }
    expect(new Set(issued).size).toBe(120);
  });

  it("rejects a fund category", () => {
    expect(() =>
      issuePlannedCode(
        { cycleSequence: 1, weekIndex: 1, categoryShortCode: "QD", priority: "fund" },
        [],
      ),
    ).toThrow(/fund/);
  });

  const bad = [
    { name: "reserved DC", input: { cycleSequence: 1, weekIndex: 1, categoryShortCode: "DC" } },
    { name: "reserved PH", input: { cycleSequence: 1, weekIndex: 1, categoryShortCode: "ph" } },
    { name: "reserved MW", input: { cycleSequence: 1, weekIndex: 1, categoryShortCode: "MW" } },
    { name: "reserved F", input: { cycleSequence: 1, weekIndex: 1, categoryShortCode: "F" } },
    {
      name: "separator in code",
      input: { cycleSequence: 1, weekIndex: 1, categoryShortCode: "A-N" },
    },
    { name: "empty code", input: { cycleSequence: 1, weekIndex: 1, categoryShortCode: "" } },
    { name: "zero sequence", input: { cycleSequence: 0, weekIndex: 1, categoryShortCode: "AN" } },
    { name: "zero week", input: { cycleSequence: 1, weekIndex: 0, categoryShortCode: "AN" } },
    {
      name: "fractional week",
      input: { cycleSequence: 1, weekIndex: 1.5, categoryShortCode: "AN" },
    },
  ];
  it.each(bad)("rejects $name", ({ input }) => {
    expect(() => issuePlannedCode(input, [])).toThrow(RangeError);
  });
});

describe("issuePenaltyCode", () => {
  it("follows MW-PH-C<seq>W<week>-<category>", () => {
    expect(issuePenaltyCode({ cycleSequence: 7, weekIndex: 2, categoryShortCode: "an" })).toBe(
      "MW-PH-C07W2-AN",
    );
  });
});

describe("issueFundingCode and cycle-level category code", () => {
  const cases = [
    {
      name: "funding",
      actual: () => issueFundingCode({ cycleSequence: 7, accountCode: "vcb" }),
      expected: "MW-F-C07-VCB",
    },
    {
      name: "fund category",
      actual: () => issueCycleCategoryCode({ cycleSequence: 7, categoryShortCode: "qd" }),
      expected: "MW-C07-QD",
    },
  ];
  it.each(cases)("$name", ({ actual, expected }) => {
    expect(actual()).toBe(expected);
  });
  it("rejects an account code with separators", () => {
    expect(() => issueFundingCode({ cycleSequence: 1, accountCode: "V-CB" })).toThrow(RangeError);
  });
});

describe("normalizeMemo", () => {
  const cases = [
    { name: "case and separators", memo: "mw c07w2 an 02", expected: "MWC07W2AN02" },
    { name: "diacritics and d-stroke", memo: "Đồ ăn MW-C07W2-AN-02", expected: "DOANMWC07W2AN02" },
    { name: "empty", memo: "", expected: "" },
  ];
  it.each(cases)("$name", ({ memo, expected }) => {
    expect(normalizeMemo(memo)).toBe(expected);
  });
});

describe("matchTransferCode", () => {
  const planned = "MW-C07W2-AN-02";
  const penalty = "MW-PH-C07W2-AN";
  const funding = "MW-F-C07-VCB";
  const fund = "MW-C07-QD";
  const issued = [planned, penalty, funding, fund, "MW-C07W2-AN-12"];
  const cases = [
    { name: "exact", memo: planned, expected: planned },
    { name: "changed case", memo: "mw-c07w2-an-02", expected: planned },
    { name: "spaces instead of dashes", memo: "MW C07W2 AN 02", expected: planned },
    { name: "dots and underscores", memo: "mw_c07w2.an.02", expected: planned },
    {
      name: "surrounding text from the bank",
      memo: "NGUYEN VAN A chuyen tien MW-C07W2-AN-02 FT2312",
      expected: planned,
    },
    { name: "penalty code", memo: "mw ph c07w2 an", expected: penalty },
    { name: "funding code", memo: "Mw-F-C07-vcb", expected: funding },
    { name: "fund category code", memo: "MW-C07-QD", expected: fund },
    { name: "longest code wins", memo: "MW-C07W2-AN-12", expected: "MW-C07W2-AN-12" },
    { name: "unissued code", memo: "MW-C07W2-AN-03", expected: null },
    { name: "no code", memo: "tien com", expected: null },
    { name: "empty memo", memo: "", expected: null },
  ];
  it.each(cases)("$name", ({ memo, expected }) => {
    expect(matchTransferCode(memo, issued)).toBe(expected);
  });
  it("matches nothing against an empty issued set", () => {
    expect(matchTransferCode(planned, [])).toBeNull();
  });
});
