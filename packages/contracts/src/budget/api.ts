import { z } from "zod";
import {
  IdSchema,
  IsoDateSchema,
  IsoDateTimeSchema,
  NonNegativeVndSchema,
  PrioritySchema,
  VndAmountSchema,
  okOrError,
} from "../common";
import {
  BankAccountSchema,
  BudgetCategorySchema,
  BudgetCycleSchema,
  DebtSchema,
  PlannedItemSchema,
  TransactionSchema,
  WeeklyLimitSchema,
} from "./entities";
import { LearnScopeSchema, SurplusTargetSchema } from "./enums";

export const CreateCycleDraftRequestSchema = z.object({
  weeks: z.number().int().positive().optional(),
  firstDay: IsoDateSchema.optional(),
});
export const CreateCycleDraftResponseSchema = okOrError(
  z.object({
    cycle: BudgetCycleSchema,
    incomePoolTotalVnd: NonNegativeVndSchema,
    suggestedBudgetVnd: NonNegativeVndSchema,
  }),
);

export const UpsertCategoryRequestSchema = BudgetCategorySchema.omit({ id: true }).extend({
  id: IdSchema.optional(),
});
export const UpsertCategoryResponseSchema = okOrError(
  z.object({ category: BudgetCategorySchema, effectiveFrom: IsoDateTimeSchema.nullable() }),
);

export const ApprovePlanRequestSchema = z.object({
  cycleId: IdSchema,
  commitmentId: IdSchema,
});
export const TransferInstructionSchema = z.object({
  bankAccountId: IdSchema,
  requiredVnd: NonNegativeVndSchema,
  memo: z.string().min(1),
});
export const ApprovePlanResponseSchema = okOrError(
  z.object({ cycle: BudgetCycleSchema, transfers: z.array(TransferInstructionSchema) }),
);

export const GetWeeklyPlanResponseSchema = okOrError(
  z.object({
    cycleId: IdSchema,
    weekIndex: z.number().int().positive(),
    limits: z.array(WeeklyLimitSchema),
    items: z.array(PlannedItemSchema),
  }),
);

export const AnswerCategoryQuestionRequestSchema = z.object({
  transactionId: IdSchema,
  answer: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("category"), categoryId: IdSchema, scope: LearnScopeSchema }),
    z.object({ kind: z.literal("internal_transfer") }),
    z.object({ kind: z.literal("income") }),
    z.object({ kind: z.literal("refund"), originalTransactionId: IdSchema }),
    z.object({ kind: z.literal("not_mine") }),
  ]),
});
export const AnswerCategoryQuestionResponseSchema = okOrError(
  z.object({ transaction: TransactionSchema }),
);

export const RecordCashExpenseRequestSchema = z.object({
  amountVnd: z.number().int().positive(),
  categoryId: IdSchema.optional(),
  note: z.string().optional(),
  occurredAt: IsoDateTimeSchema.optional(),
});
export const RecordCashExpenseResponseSchema = okOrError(
  z.object({ transaction: TransactionSchema }),
);

export const ClaimExceptionRequestSchema = z.object({
  cycleId: IdSchema,
  weekIndex: z.number().int().positive(),
  categoryId: IdSchema,
});

export const BudgetStatusResponseSchema = okOrError(
  z.object({
    cycleId: IdSchema,
    weekIndex: z.number().int().positive(),
    categories: z.array(
      z.object({
        categoryId: IdSchema,
        priority: PrioritySchema,
        weeklyLimitVnd: NonNegativeVndSchema,
        spentVnd: VndAmountSchema,
        remainingVnd: VndAmountSchema,
      }),
    ),
  }),
);

export const SubmitBalanceSnapshotRequestSchema = z.object({
  bankAccountId: IdSchema,
  balanceVnd: VndAmountSchema,
  takenAt: IsoDateTimeSchema,
});

export const CreateDebtRequestSchema = DebtSchema.pick({
  kind: true,
  person: true,
  amountVnd: true,
  dueAt: true,
  fundingCategoryId: true,
});

export const SurplusAllocationSchema = z.object({
  cycleId: IdSchema,
  totalVnd: NonNegativeVndSchema,
  savingsVnd: NonNegativeVndSchema,
  futurePurchasesVnd: NonNegativeVndSchema,
  remainderVnd: NonNegativeVndSchema,
  remainderTarget: SurplusTargetSchema,
});
export type SurplusAllocation = z.infer<typeof SurplusAllocationSchema>;

export const BankAccountListResponseSchema = okOrError(z.object({ accounts: z.array(BankAccountSchema) }));
export const DebtListResponseSchema = okOrError(z.object({ debts: z.array(DebtSchema) }));
