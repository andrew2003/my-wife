import { describe, expect, it } from "vitest";
import { reconcilePlannedTransfer, toleranceVnd } from "../src/reconciliation";

const tolerance = { percent: 5, minVnd: 10000 };

describe("toleranceVnd", () => {
  const rows = [
    { name: "minimum wins on small plans", planned: 100000, tol: tolerance, expected: 10000 },
    { name: "percent wins on large plans", planned: 1000000, tol: tolerance, expected: 50000 },
    { name: "equal percent and minimum", planned: 200000, tol: tolerance, expected: 10000 },
    {
      name: "zero percent keeps the minimum",
      planned: 500000,
      tol: { percent: 0, minVnd: 3000 },
      expected: 3000,
    },
    {
      name: "fraction is floored to whole VND",
      planned: 12345,
      tol: { percent: 5, minVnd: 0 },
      expected: 617,
    },
  ];
  it.each(rows)("$name", ({ planned, tol, expected }) => {
    expect(toleranceVnd(planned, tol)).toBe(expected);
  });
});

describe("reconcilePlannedTransfer", () => {
  const base = {
    plannedVnd: 100000,
    tolerance,
    payingAccountId: "a1",
    categoryAccountId: "a1",
  };
  const rows = [
    { name: "exact amount", input: { ...base, amountVnd: 100000 }, expected: "matched" },
    { name: "within tolerance above", input: { ...base, amountVnd: 109000 }, expected: "matched" },
    {
      name: "boundary above is matched",
      input: { ...base, amountVnd: 110000 },
      expected: "matched",
    },
    {
      name: "one VND over is mismatch",
      input: { ...base, amountVnd: 110001 },
      expected: "amount_mismatch",
    },
    {
      name: "111,000 is mismatch",
      input: { ...base, amountVnd: 111000 },
      expected: "amount_mismatch",
    },
    {
      name: "boundary below is matched",
      input: { ...base, amountVnd: 90000 },
      expected: "matched",
    },
    {
      name: "one VND under is mismatch",
      input: { ...base, amountVnd: 89999 },
      expected: "amount_mismatch",
    },
    {
      name: "zero amount is mismatch",
      input: { ...base, amountVnd: 0 },
      expected: "amount_mismatch",
    },
    {
      name: "wrong bank with matching amount",
      input: { ...base, amountVnd: 100000, payingAccountId: "a2" },
      expected: "wrong_bank",
    },
    {
      name: "wrong bank beats amount mismatch",
      input: { ...base, amountVnd: 500000, payingAccountId: "a2" },
      expected: "wrong_bank",
    },
    {
      name: "custom tolerance is honored",
      input: { ...base, amountVnd: 103000, tolerance: { percent: 1, minVnd: 1000 } },
      expected: "amount_mismatch",
    },
  ];
  it.each(rows)("$name", ({ input, expected }) => {
    expect(reconcilePlannedTransfer(input)).toBe(expected);
  });
});
