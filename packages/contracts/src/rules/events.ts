import { z } from "zod";
import { IdSchema, IsoDateTimeSchema, NonNegativeVndSchema } from "../common";
import {
  AppealOutcomeSchema,
  FaultTypeSchema,
  PenaltySourceSchema,
  RuleChangeDirectionSchema,
  WaiverCauseSchema,
} from "./enums";

const penaltyRef = z.object({
  penaltyId: IdSchema,
  source: PenaltySourceSchema,
  amountVnd: NonNegativeVndSchema,
});

export const rulesEvents = {
  "fault.recorded": z.object({
    faultId: IdSchema,
    type: FaultTypeSchema,
    points: z.number().int().nonnegative(),
    occurredAt: IsoDateTimeSchema,
  }),
  "fault.waived": z.object({
    faultId: IdSchema,
    cause: WaiverCauseSchema,
    kind: z.enum(["system", "card"]),
  }),
  "fault.appeal_decided": z.object({
    appealId: IdSchema,
    faultId: IdSchema,
    outcome: AppealOutcomeSchema,
  }),
  "penalty.issued": penaltyRef.extend({ transferCode: z.string(), dueDate: IsoDateTimeSchema }),
  "penalty.suspended": penaltyRef,
  "penalty.due": penaltyRef.extend({ transferCode: z.string(), dueDate: IsoDateTimeSchema }),
  "penalty.paid": penaltyRef.extend({ transactionId: IdSchema }),
  "penalty.unpaid": penaltyRef.extend({ daysLate: z.number().int().nonnegative() }),
  "penalty.cap_carried": z.object({
    weekStart: z.string(),
    carriedVnd: NonNegativeVndSchema,
  }),
  "trial.started": z.object({
    weeks: z.number().int().positive(),
    installmentsK: z.number().int().positive(),
    endsAt: IsoDateTimeSchema,
  }),
  "trial.ended": z.object({
    reason: z.enum(["elapsed", "turned_off", "account_closing"]),
    suspendedTotalVnd: NonNegativeVndSchema,
    finalAppealEndsAt: IsoDateTimeSchema,
  }),
  "trial.settled": z.object({
    totalVnd: NonNegativeVndSchema,
    installmentsK: z.number().int().positive(),
  }),
  "contract.signed": z.object({
    contractId: IdSchema,
    cycleId: IdSchema,
    version: z.number().int().positive(),
  }),
  "rule.changed": z.object({
    key: z.string().min(1),
    direction: RuleChangeDirectionSchema,
    effectiveFrom: IsoDateTimeSchema,
  }),
  "reward.unlocked": z.object({ amountVnd: NonNegativeVndSchema, categoryId: IdSchema.nullable() }),
  "appeal.opened": z.object({
    appealId: IdSchema,
    subjectKind: z.enum(["fault", "classification", "wake_photo_grade", "trial_summary"]),
    subjectId: IdSchema,
  }),
};
