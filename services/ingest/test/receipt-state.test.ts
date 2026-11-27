import { describe, expect, it } from "vitest";
import type { ReceiptState } from "@my-wife/contracts";
import { assertTransition, canTransition } from "../src/receipt-state";

const ALL: ReceiptState[] = [
  "received",
  "rejected",
  "duplicate",
  "parsing",
  "needs_confirmation",
  "parsed",
  "failed",
];

const ALLOWED: Array<[ReceiptState, ReceiptState]> = [
  ["received", "rejected"],
  ["received", "duplicate"],
  ["received", "parsing"],
  ["received", "needs_confirmation"],
  ["parsing", "parsed"],
  ["parsing", "needs_confirmation"],
  ["parsing", "failed"],
  ["parsing", "duplicate"],
  ["needs_confirmation", "parsing"],
  ["needs_confirmation", "parsed"],
  ["needs_confirmation", "failed"],
  ["needs_confirmation", "duplicate"],
];

describe("receipt state machine", () => {
  it.each(ALL.flatMap((from) => ALL.map((to) => [from, to] as const)))("%s -> %s", (from, to) => {
    const expected = ALLOWED.some(([f, t]) => f === from && t === to);
    expect(canTransition(from, to)).toBe(expected);
  });

  it("throws on an illegal transition", () => {
    expect(() => assertTransition("rejected", "parsed")).toThrow(/rejected.*parsed/);
    expect(() => assertTransition("received", "parsing")).not.toThrow();
  });
});
