import { describe, expect, it } from "vitest";
import {
  allocatePenaltySource,
  computeWithdrawalPenalty,
  InMemoryPenaltyDebtStore,
  type WantLimit,
} from "../src/penalty-source";

const wants = (...r: [string, number][]): WantLimit[] =>
  r.map(([categoryId, remainingLimitVnd]) => ({ categoryId, remainingLimitVnd }));

describe("allocatePenaltySource", () => {
  const cases: {
    name: string;
    penalty: number;
    list: WantLimit[];
    order?: string[];
    deductions: [string, number][];
    shortfall: number;
  }[] = [
    {
      name: "fits in the first category",
      penalty: 30_000,
      list: wants(["a", 100_000], ["b", 50_000]),
      deductions: [["a", 30_000]],
      shortfall: 0,
    },
    {
      name: "spills over to the next category in list order",
      penalty: 120_000,
      list: wants(["a", 100_000], ["b", 50_000]),
      deductions: [
        ["a", 100_000],
        ["b", 20_000],
      ],
      shortfall: 0,
    },
    {
      name: "sources exhausted: shortfall becomes debt",
      penalty: 200_000,
      list: wants(["a", 100_000], ["b", 50_000]),
      deductions: [
        ["a", 100_000],
        ["b", 50_000],
      ],
      shortfall: 50_000,
    },
    {
      name: "empty want list: all of it is debt",
      penalty: 40_000,
      list: [],
      deductions: [],
      shortfall: 40_000,
    },
    {
      name: "configured order wins over list order",
      penalty: 60_000,
      list: wants(["a", 100_000], ["b", 100_000]),
      order: ["b", "a"],
      deductions: [["b", 60_000]],
      shortfall: 0,
    },
    {
      name: "configured order ignores unknown ids and categories not listed",
      penalty: 60_000,
      list: wants(["a", 100_000], ["b", 10_000]),
      order: ["zzz", "b"],
      deductions: [["b", 10_000]],
      shortfall: 50_000,
    },
    {
      name: "zero and invalid remaining limits are skipped",
      penalty: 10_000,
      list: wants(["a", 0], ["b", -5], ["c", 1.5], ["d", 20_000]),
      deductions: [["d", 10_000]],
      shortfall: 0,
    },
    {
      name: "zero penalty deducts nothing",
      penalty: 0,
      list: wants(["a", 100]),
      deductions: [],
      shortfall: 0,
    },
    {
      name: "invalid penalty counts as zero",
      penalty: -1,
      list: wants(["a", 100]),
      deductions: [],
      shortfall: 0,
    },
  ];
  it.each(cases)("$name", ({ penalty, list, order, deductions, shortfall }) => {
    const r = allocatePenaltySource({ penaltyVnd: penalty, wants: list, order: order ?? [] });
    expect(r.deductions.map((d) => [d.categoryId, d.amountVnd])).toEqual(deductions);
    expect(r.shortfallVnd).toBe(shortfall);
    expect(r.deductions.reduce((s, d) => s + d.amountVnd, 0) + r.shortfallVnd).toBe(
      Number.isInteger(penalty) && penalty > 0 ? penalty : 0,
    );
  });
});

describe("computeWithdrawalPenalty", () => {
  const cases: [string, number, number, number, number][] = [
    ["default 20 percent", 1_000_000, 20, 1_000_000, 200_000],
    ["zero extra", 500_000, 0, 500_000, 0],
    ["rounds half up", 1_005, 50, 1_005, 503],
    ["rounds down below half", 1_001, 10, 1_001, 100],
    ["zero withdrawn", 0, 20, 0, 0],
    ["invalid withdrawn counts as zero", -10, 20, 0, 0],
    ["invalid percent falls back to the default", 100_000, 150, 100_000, 20_000],
  ];
  it.each(cases)("%s", (_n, withdrawn, percent, repayment, extra) => {
    const r = computeWithdrawalPenalty(withdrawn, { extraPercent: percent });
    expect(r).toEqual({ repaymentVnd: repayment, extraVnd: extra, totalVnd: repayment + extra });
  });
});

describe("InMemoryPenaltyDebtStore", () => {
  const rec = (penaltyId: string, shortfallVnd: number) => ({
    id: `r-${penaltyId}`,
    penaltyId,
    at: "2026-11-27T00:00:00.000Z",
    carriedInVnd: 0,
    penaltyVnd: shortfallVnd,
    deductions: [],
    shortfallVnd,
  });
  it("keeps one record per penalty and reports the latest shortfall as the balance", () => {
    const s = new InMemoryPenaltyDebtStore();
    expect(s.balance("u")).toBe(0);
    expect(s.insertOnce("u", rec("p1", 50_000))).toBe(true);
    expect(s.insertOnce("u", rec("p1", 1))).toBe(false);
    expect(s.insertOnce("u", rec("p2", 20_000))).toBe(true);
    expect(s.balance("u")).toBe(20_000);
    expect(s.balance("other")).toBe(0);
  });
});
