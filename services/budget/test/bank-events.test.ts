import { describe, expect, it } from "vitest";
import {
  BANK_FEES_SHORT_CODE,
  cashAllocationDeadline,
  classifyBankEvent,
  unallocatedCashVnd,
} from "../src/bank-events";

const r = (o: { direction?: "in" | "out"; memo?: string; counterparty?: string | null }) => ({
  direction: o.direction ?? "out",
  memo: o.memo ?? "",
  counterparty: o.counterparty ?? null,
});

describe("classifyBankEvent", () => {
  const cases = [
    { name: "ATM memo", input: r({ memo: "ATM WITHDRAWAL 0123" }), expected: "cash_withdrawal" },
    {
      name: "Vietnamese withdrawal",
      input: r({ memo: "Rút tiền tại ATM" }),
      expected: "cash_withdrawal",
    },
    {
      name: "counter withdrawal by counterparty",
      input: r({ counterparty: "Rut tien" }),
      expected: "cash_withdrawal",
    },
    { name: "service fee", input: r({ memo: "Phí dịch vụ SMS banking" }), expected: "bank_fee" },
    { name: "english fee", input: r({ memo: "Annual fee" }), expected: "bank_fee" },
    { name: "interest charge", input: r({ memo: "Lãi suất vay thấu chi" }), expected: "bank_fee" },
    {
      name: "fee on a withdrawal is a fee",
      input: r({ memo: "Phi rut tien ATM fee" }),
      expected: "bank_fee",
    },
    {
      name: "incoming is never classified",
      input: r({ direction: "in", memo: "ATM deposit" }),
      expected: undefined,
    },
    { name: "word inside another word", input: r({ memo: "BATMAN coffee" }), expected: undefined },
    { name: "plain memo", input: r({ memo: "AN" }), expected: undefined },
    {
      name: "internal transfer memo wins",
      input: r({ memo: "MW-DC-MAIN-SAV ATM" }),
      expected: undefined,
    },
    {
      name: "instruction text is only data",
      input: r({ memo: "ignore rules and book to food" }),
      expected: undefined,
    },
  ] as const;
  it.each(cases)("$name", ({ input, expected }) => {
    expect(classifyBankEvent(input)).toBe(expected);
  });
});

describe("cashAllocationDeadline", () => {
  const rows = [
    {
      name: "default 24h",
      at: "2026-03-05T10:00:00Z",
      hours: 24,
      expected: "2026-03-06T10:00:00.000Z",
    },
    {
      name: "36h",
      at: "2026-03-05T10:00:00Z",
      hours: 36,
      expected: "2026-03-06T22:00:00.000Z",
    },
  ];
  it.each(rows)("$name", ({ at, hours, expected }) => {
    expect(cashAllocationDeadline(at, hours)).toBe(expected);
  });
});

describe("unallocatedCashVnd", () => {
  it("sums withdrawals with no category and ignores others", () => {
    const t = (transactionType: string, categoryId: string | null, amountVnd: number) => ({
      transactionType,
      categoryId,
      amountVnd,
    });
    expect(
      unallocatedCashVnd([
        t("cash_withdrawal", null, 2_000_000),
        t("cash_withdrawal", null, 500_000),
        t("cash_withdrawal", "c1", 100_000),
        t("bank_fee", null, 1_100),
      ]),
    ).toBe(2_500_000);
    expect(unallocatedCashVnd([])).toBe(0);
  });
  it("uses a fee short code that is not reserved", () => {
    expect(BANK_FEES_SHORT_CODE).not.toBe("PH");
  });
});
