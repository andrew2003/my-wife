/**
 * The eight steps an unknown receipt layout goes through (spec 11, section 2), in order.
 * Steps 1 to 3 run when the mail arrives, 4 and 5 when the ai service answers, and 6 to 8
 * when the read is accepted (at once, or after the user confirms the first read).
 */
export const UNKNOWN_RECEIPT_STEPS = [
  "authenticate",
  "deduplicate_message",
  "fingerprint",
  "read",
  "verify",
  "deduplicate_reference",
  "learn",
  "emit",
] as const;

export type UnknownReceiptStep = (typeof UNKNOWN_RECEIPT_STEPS)[number];

/** One audit entry of the trace kept on the receipt. */
export type StepRecord = { step: UnknownReceiptStep; outcome: string; at: string };

export const stepAt = (step: UnknownReceiptStep, outcome: string, now: Date): StepRecord => ({
  step,
  outcome,
  at: now.toISOString(),
});

export const withSteps = <T extends { steps?: StepRecord[] }>(
  record: T,
  ...added: StepRecord[]
): T => ({ ...record, steps: [...(record.steps ?? []), ...added] });

/**
 * Failed verifications of model reads before a receipt is `failed` (spec: "verification
 * failed twice"). Not in the settings registry yet; `ingest.llm_read_attempts` is a follow-up.
 */
export const DEFAULT_LLM_READ_ATTEMPTS = 2;

export const llmReadAttempts = (configured: number | undefined): number =>
  configured ?? DEFAULT_LLM_READ_ATTEMPTS;
