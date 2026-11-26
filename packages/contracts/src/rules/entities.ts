import { z } from "zod";
import { IdSchema, IsoDateTimeSchema, NonNegativeVndSchema, PrioritySchema } from "../common";
import {
  AppealStatusSchema,
  FaultStatusSchema,
  FaultTypeSchema,
  PenaltySourceSchema,
  PenaltyStatusSchema,
  WaiverCauseSchema,
} from "./enums";

export const FaultEntrySchema = z.object({
  id: IdSchema,
  type: FaultTypeSchema,
  occurredAt: IsoDateTimeSchema,
  signalRef: z.string().min(1),
  reasonRef: IdSchema.nullable(),
  weightSnapshot: z.number().int().nonnegative(),
  points: z.number().int().nonnegative(),
  status: FaultStatusSchema,
  waiver: WaiverCauseSchema.nullable(),
  systemCause: z.string().nullable(),
});
export type FaultEntry = z.infer<typeof FaultEntrySchema>;

export const PenaltyLedgerEntrySchema = z.object({
  id: IdSchema,
  source: PenaltySourceSchema,
  amountVnd: NonNegativeVndSchema,
  status: PenaltyStatusSchema,
  dueDate: IsoDateTimeSchema.nullable(),
  transferCode: z.string().min(1),
  paymentTransactionId: IdSchema.nullable(),
  auditRefs: z.array(z.string()),
  contractId: IdSchema.nullable(),
});
export type PenaltyLedgerEntry = z.infer<typeof PenaltyLedgerEntrySchema>;

export const PenaltyThresholdSchema = z.object({
  points: z.number().int().positive(),
  amountVnd: NonNegativeVndSchema,
});
export type PenaltyThreshold = z.infer<typeof PenaltyThresholdSchema>;

export const CommitmentContractSchema = z.object({
  id: IdSchema,
  cycleId: IdSchema,
  version: z.number().int().positive(),
  signedAt: IsoDateTimeSchema,
  summary: z.object({
    budgetRules: z.record(z.unknown()),
    supervisionWindows: z.array(z.record(z.unknown())),
    thresholds: z.array(PenaltyThresholdSchema),
    weeklyCapVnd: NonNegativeVndSchema,
    commitRoutines: z.array(z.string()),
    penaltySavingsUnlock: z.object({
      kind: z.enum(["maturity_date", "goal"]),
      value: z.string().min(1),
    }),
  }),
});

export const AppealSchema = z.object({
  id: IdSchema,
  subjectKind: z.enum(["fault", "classification", "wake_photo_grade", "trial_summary"]),
  subjectId: IdSchema,
  status: AppealStatusSchema,
  reasonText: z.string().min(1),
  openedAt: IsoDateTimeSchema,
  windowEndsAt: IsoDateTimeSchema,
  hasEvidenceFrame: z.boolean(),
});

/** Result of the pure function computePenaltyForWeek. */
export const WeeklyPenaltyResultSchema = z.object({
  rawAmountVnd: NonNegativeVndSchema,
  issuedAmountVnd: NonNegativeVndSchema,
  carryOverVnd: NonNegativeVndSchema,
});
export type WeeklyPenaltyResult = z.infer<typeof WeeklyPenaltyResultSchema>;

export const PenaltyDeductionSchema = z.object({
  categoryId: IdSchema,
  priority: PrioritySchema,
  deductedVnd: NonNegativeVndSchema,
});
