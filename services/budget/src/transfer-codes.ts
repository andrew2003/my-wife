/**
 * Transfer codes (spec 10-budget.md section 4 and 5). Pure functions.
 *
 * Only the budget service issues codes. Ingest and other services may only
 * use `normalizeMemo` and `matchTransferCode` against codes budget issued.
 * Matching never parses free text with an LLM.
 */

/** Short codes users may not pick, because they are part of code syntax. */
export const RESERVED_SHORT_CODES: readonly string[] = ["DC", "PH", "MW", "F"];

export interface CycleWeekCategory {
  cycleSequence: number;
  weekIndex: number;
  categoryShortCode: string;
}

export interface PlannedCodeInput extends CycleWeekCategory {
  /** Category priority; a `fund` category has only the cycle-level code. */
  priority?: "need" | "should" | "want" | "fund";
}

function assertPositiveInt(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function cleanCode(value: string, name: string, reserved: boolean): string {
  const code = value.toUpperCase();
  if (!/^[A-Z0-9]+$/.test(code)) {
    throw new RangeError(`${name} must be non-empty letters and digits only`);
  }
  if (reserved && RESERVED_SHORT_CODES.includes(code)) {
    throw new RangeError(`${name} must not be a reserved code`);
  }
  return code;
}

function seq(cycleSequence: number): string {
  assertPositiveInt(cycleSequence, "cycleSequence");
  return String(cycleSequence).padStart(2, "0");
}

/** Planned item code `MW-C<seq>W<week>-<category>-<nn>`, unique among `existingCodes`. */
export function issuePlannedCode(input: PlannedCodeInput, existingCodes: readonly string[]): string {
  if (input.priority === "fund") {
    throw new RangeError("a fund category has only the cycle-level code");
  }
  assertPositiveInt(input.weekIndex, "weekIndex");
  const category = cleanCode(input.categoryShortCode, "categoryShortCode", true);
  const prefix = `MW-C${seq(input.cycleSequence)}W${input.weekIndex}-${category}-`;
  let max = 0;
  for (const code of existingCodes) {
    if (code.toUpperCase().startsWith(prefix)) {
      const n = Number(code.slice(prefix.length));
      if (Number.isSafeInteger(n) && n > max) max = n;
    }
  }
  return `${prefix}${String(max + 1).padStart(2, "0")}`;
}

/** Penalty payment code `MW-PH-C<seq>W<week>-<category>`. */
export function issuePenaltyCode(input: CycleWeekCategory): string {
  assertPositiveInt(input.weekIndex, "weekIndex");
  const category = cleanCode(input.categoryShortCode, "categoryShortCode", true);
  return `MW-PH-C${seq(input.cycleSequence)}W${input.weekIndex}-${category}`;
}

/** Cycle funding code per bank account `MW-F-C<seq>-<accountCode>`. */
export function issueFundingCode(input: { cycleSequence: number; accountCode: string }): string {
  const account = cleanCode(input.accountCode, "accountCode", false);
  return `MW-F-C${seq(input.cycleSequence)}-${account}`;
}

/** Cycle-level code of a `fund` category `MW-C<seq>-<category>`. */
export function issueCycleCategoryCode(input: { cycleSequence: number; categoryShortCode: string }): string {
  const category = cleanCode(input.categoryShortCode, "categoryShortCode", true);
  return `MW-C${seq(input.cycleSequence)}-${category}`;
}

/** Uppercase, strip diacritics (including d-stroke) and every non-alphanumeric. */
export function normalizeMemo(memo: string): string {
  return memo
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[đĐ]/g, "D")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/**
 * Find the issued code contained in a memo. The longest normalized code wins
 * so a code that is a prefix of another cannot shadow it. Returns the issued
 * code as given, or null.
 */
export function matchTransferCode(memo: string, issuedCodes: readonly string[]): string | null {
  const normalizedMemo = normalizeMemo(memo);
  if (normalizedMemo === "") return null;
  let best: { code: string; length: number } | null = null;
  for (const code of issuedCodes) {
    const normalized = normalizeMemo(code);
    if (normalized !== "" && normalizedMemo.includes(normalized) && (!best || normalized.length > best.length)) {
      best = { code, length: normalized.length };
    }
  }
  return best?.code ?? null;
}
