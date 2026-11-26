import { z } from "zod";
import {
  IdSchema,
  IsoDateSchema,
  IsoDateTimeSchema,
  NonNegativeVndSchema,
  PrioritySchema,
  VndAmountSchema,
} from "../common";
import {
  BalanceSourceSchema,
  BankAccountKindSchema,
  CategoryKindSchema,
  CycleStateSchema,
  DebtKindSchema,
  DebtStateSchema,
  DirectionSchema,
  LearnScopeSchema,
  PlannedItemStatusSchema,
  ReconciliationResultSchema,
  TransactionTypeSchema,
} from "./enums";

export const BudgetCycleSchema = z.object({
  id: IdSchema,
  sequence: z.number().int().positive(),
  weeks: z.number().int().positive(),
  firstDay: IsoDateSchema,
  state: CycleStateSchema,
  openedAt: IsoDateTimeSchema.nullable(),
  closedAt: IsoDateTimeSchema.nullable(),
  commitmentId: IdSchema.nullable(),
});
export type BudgetCycle = z.infer<typeof BudgetCycleSchema>;

export const BudgetCategorySchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  shortCode: z.string().min(1),
  priority: PrioritySchema,
  kind: CategoryKindSchema,
  countsTowardSurplus: z.boolean(),
  bankAccountId: IdSchema,
  cycleLimitVnd: NonNegativeVndSchema,
  wantOrder: z.number().int().nonnegative().nullable(),
});
export type BudgetCategory = z.infer<typeof BudgetCategorySchema>;

export const BankAccountSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  code: z.string().min(1),
  kind: BankAccountKindSchema,
  emailNotificationsConfirmed: z.boolean(),
});
export type BankAccount = z.infer<typeof BankAccountSchema>;

export const PlannedItemSchema = z.object({
  id: IdSchema,
  categoryId: IdSchema,
  number: z.number().int().positive(),
  amountVnd: NonNegativeVndSchema,
  transferCode: z.string().min(1),
  status: PlannedItemStatusSchema,
});
export type PlannedItem = z.infer<typeof PlannedItemSchema>;

export const WeeklyLimitSchema = z.object({
  categoryId: IdSchema,
  weekIndex: z.number().int().positive(),
  limitVnd: NonNegativeVndSchema,
});

export const TransactionSchema = z.object({
  id: IdSchema,
  receiptId: IdSchema.nullable(),
  bankAccountId: IdSchema,
  direction: DirectionSchema,
  amountVnd: VndAmountSchema,
  occurredAt: IsoDateTimeSchema,
  memo: z.string(),
  counterparty: z.string().nullable(),
  transactionType: TransactionTypeSchema,
  reconciliationResult: ReconciliationResultSchema,
  categoryId: IdSchema.nullable(),
  plannedItemId: IdSchema.nullable(),
  cycleId: IdSchema,
  weekIndex: z.number().int().positive(),
  linkedTransactionId: IdSchema.nullable(),
  adjustmentOf: IdSchema.nullable(),
});
export type Transaction = z.infer<typeof TransactionSchema>;

export const BalanceSnapshotSchema = z.object({
  bankAccountId: IdSchema,
  balanceVnd: VndAmountSchema,
  source: BalanceSourceSchema,
  takenAt: IsoDateTimeSchema,
});

export const DebtSchema = z.object({
  id: IdSchema,
  kind: DebtKindSchema,
  person: z.string().min(1),
  amountVnd: NonNegativeVndSchema,
  settledVnd: NonNegativeVndSchema,
  dueAt: IsoDateTimeSchema.nullable(),
  state: DebtStateSchema,
  fundingCategoryId: IdSchema.nullable(),
});
export type Debt = z.infer<typeof DebtSchema>;

export const IncomePoolEntrySchema = z.object({
  id: IdSchema,
  amountVnd: NonNegativeVndSchema,
  payer: z.string().min(1),
  receivedAt: IsoDateTimeSchema,
  allocatedCycleId: IdSchema.nullable(),
});

export const WishlistItemSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  priceVnd: NonNegativeVndSchema,
  savedVnd: NonNegativeVndSchema,
});

export const LearnedPayeeSchema = z.object({
  counterpartyKey: z.string().min(1),
  categoryId: IdSchema,
  scope: LearnScopeSchema,
  amountVnd: NonNegativeVndSchema.nullable(),
});
