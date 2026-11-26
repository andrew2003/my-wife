import { z } from "zod";
import { IdSchema, IsoDateTimeSchema, okOrError } from "../common";
import {
  AppealOutcomeSchema,
  RuleChangeDirectionSchema,
} from "./enums";
import {
  AppealSchema,
  CommitmentContractSchema,
  FaultEntrySchema,
  PenaltyLedgerEntrySchema,
} from "./entities";

export const SignContractRequestSchema = z.object({ cycleId: IdSchema });
export const SignContractResponseSchema = okOrError(
  z.object({ contract: CommitmentContractSchema }),
);

export const ListFaultsResponseSchema = okOrError(z.object({ faults: z.array(FaultEntrySchema) }));
export const ListPenaltiesResponseSchema = okOrError(
  z.object({ penalties: z.array(PenaltyLedgerEntrySchema), suspendedTotalVnd: z.number().int() }),
);

export const SpendWaiverRequestSchema = z.object({ faultId: IdSchema });
export const OpenAppealRequestSchema = AppealSchema.pick({
  subjectKind: true,
  subjectId: true,
  reasonText: true,
});
export const OpenAppealResponseSchema = okOrError(z.object({ appeal: AppealSchema }));
export const DecideAppealRequestSchema = z.object({
  appealId: IdSchema,
  outcome: AppealOutcomeSchema,
  note: z.string().optional(),
});

export const ClassifyRuleChangeRequestSchema = z.object({
  key: z.string().min(1),
  oldValue: z.unknown(),
  newValue: z.unknown(),
});
export const ClassifyRuleChangeResponseSchema = okOrError(
  z.object({
    direction: RuleChangeDirectionSchema,
    effectiveFrom: IsoDateTimeSchema,
  }),
);

export const StartTrialRequestSchema = z.object({
  weeks: z.number().int().positive().optional(),
  installmentsK: z.number().int().positive().optional(),
});
