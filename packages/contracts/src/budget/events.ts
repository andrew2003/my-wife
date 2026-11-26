import { z } from "zod";
import {
  IdSchema,
  IsoDateSchema,
  IsoDateTimeSchema,
  NonNegativeVndSchema,
  PrioritySchema,
  VndAmountSchema,
} from "../common";
import { SurplusAllocationSchema } from "./api";
import { AnomalyKindSchema, ReconciliationResultSchema, TransactionTypeSchema } from "./enums";

const cycleRef = z.object({ cycleId: IdSchema });
const txnRef = z.object({ transactionId: IdSchema, cycleId: IdSchema });

export const QuestionOptionRefSchema = z.object({
  value: z.string().min(1),
  labelKey: z.string().min(1),
});
/** Shared by every `ask.*` event; notify turns it into a question with buttons. */
export const AskPayloadSchema = z.object({
  questionId: IdSchema,
  kind: z.string().min(1),
  subjectRef: z.string().min(1),
  options: z.array(QuestionOptionRefSchema).min(1),
  expiresAt: IsoDateTimeSchema,
  params: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
});
export type AskPayload = z.infer<typeof AskPayloadSchema>;

export const budgetEvents = {
  "cycle.draft_created": cycleRef.extend({ sequence: z.number().int().positive() }),
  "cycle.funds_requested": cycleRef.extend({
    transfers: z.array(
      z.object({ bankAccountId: IdSchema, requiredVnd: NonNegativeVndSchema, memo: z.string() }),
    ),
  }),
  "cycle.opened": cycleRef.extend({ sequence: z.number().int().positive(), firstDay: IsoDateSchema }),
  "cycle.closing": cycleRef,
  "cycle.closed": cycleRef.extend({ surplus: SurplusAllocationSchema }),
  "plan.week_published": cycleRef.extend({ weekIndex: z.number().int().positive() }),
  "txn.recorded": txnRef.extend({
    amountVnd: VndAmountSchema,
    direction: z.enum(["in", "out"]),
    transactionType: TransactionTypeSchema,
    reconciliationResult: ReconciliationResultSchema,
    categoryId: IdSchema.nullable(),
    bankAccountId: IdSchema,
    memo: z.string(),
  }),
  "txn.reclassified": txnRef.extend({ categoryId: IdSchema.nullable(), byAppeal: z.boolean() }),
  "txn.adjusted": txnRef.extend({ adjustmentOf: IdSchema, amountVnd: VndAmountSchema }),
  "overspend.detected": cycleRef.extend({
    weekIndex: z.number().int().positive(),
    categoryId: IdSchema,
    priority: PrioritySchema,
    weeklyLimitVnd: NonNegativeVndSchema,
    spentVnd: VndAmountSchema,
    excessVnd: NonNegativeVndSchema,
  }),
  "exception.used": cycleRef.extend({
    weekIndex: z.number().int().positive(),
    categoryId: IdSchema,
    excessVnd: NonNegativeVndSchema,
  }),
  "anomaly.opened": z.object({
    anomalyId: IdSchema,
    kind: AnomalyKindSchema,
    subjectRef: z.string().min(1),
    question: AskPayloadSchema.optional(),
  }),
  "anomaly.resolved": z.object({ anomalyId: IdSchema, resolution: z.string().min(1) }),
  "balance.discrepancy_found": z.object({
    bankAccountId: IdSchema,
    expectedVnd: VndAmountSchema,
    actualVnd: VndAmountSchema,
    differenceVnd: VndAmountSchema,
  }),
  "penalty_savings.withdrawal_detected": z.object({
    bankAccountId: IdSchema,
    amountVnd: NonNegativeVndSchema,
    transactionId: IdSchema.nullable(),
    detectedBy: z.enum(["receipt", "balance_reconciliation"]),
  }),
  "debt.opened": z.object({
    debtId: IdSchema,
    kind: z.enum(["receivable", "payable"]),
    amountVnd: NonNegativeVndSchema,
    dueAt: IsoDateTimeSchema.nullable(),
  }),
  "debt.overdue": z.object({ debtId: IdSchema, daysOverdue: z.number().int().nonnegative() }),
  "debt.written_off": z.object({
    debtId: IdSchema,
    amountVnd: NonNegativeVndSchema,
    bookedToCategoryId: IdSchema.nullable(),
  }),
  "income.recorded": z.object({
    entryId: IdSchema,
    amountVnd: NonNegativeVndSchema,
    payer: z.string(),
  }),
  "surplus.allocated": SurplusAllocationSchema,
  "ask.budget_category": AskPayloadSchema,
};
