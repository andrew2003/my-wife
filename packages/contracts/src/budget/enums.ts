import { z } from "zod";

export const CycleStateSchema = z.enum(["draft", "awaiting_funds", "running", "closing", "closed"]);
export type CycleState = z.infer<typeof CycleStateSchema>;

export const CategoryKindSchema = z.enum(["fixed", "variable"]);
export const BankAccountKindSchema = z.enum(["spending", "penalty_savings", "savings"]);

export const TransactionTypeSchema = z.enum([
  "planned_transfer",
  "coded_unplanned",
  "third_party_payment",
  "foreign_card",
  "subscription",
  "internal_transfer",
  "cycle_funding",
  "penalty_payment",
  "income",
  "debt_repayment_in",
  "debt_repayment_out",
  "loan_out",
  "loan_in",
  "group_expense",
  "refund",
  "cash_withdrawal",
  "credit_card_payment",
  "bank_fee",
  "unknown",
]);
export type TransactionType = z.infer<typeof TransactionTypeSchema>;

export const ReconciliationResultSchema = z.enum([
  "matched",
  "amount_mismatch",
  "unplanned",
  "unknown",
  "wrong_bank",
  "internal_transfer",
  "not_executed",
  "penalty_unpaid",
  "adjusted",
]);
export type ReconciliationResult = z.infer<typeof ReconciliationResultSchema>;

export const DirectionSchema = z.enum(["in", "out"]);
export type Direction = z.infer<typeof DirectionSchema>;

export const DebtKindSchema = z.enum(["receivable", "payable"]);
export const DebtStateSchema = z.enum(["open", "partially_settled", "settled", "written_off"]);

export const LearnScopeSchema = z.enum(["once", "payee", "payee_and_amount"]);
export type LearnScope = z.infer<typeof LearnScopeSchema>;

export const PlannedItemStatusSchema = z.enum(["planned", "matched", "mismatch", "not_executed"]);

export const BalanceSourceSchema = z.enum(["user", "email"]);

export const AnomalyKindSchema = z.enum([
  "unknown_transaction",
  "unknown_receipt",
  "missing_receipt",
  "unclassified_income",
  "needs_confirmation",
  "receipt_failed",
  "template_demoted",
]);
export type AnomalyKind = z.infer<typeof AnomalyKindSchema>;

export const SurplusTargetSchema = z.enum(["savings", "future_purchases"]);

/** Where an unresolved amount was booked (docs/decisions.md, rule 7 of 10-budget.md). */
export const FallbackBookingSchema = z.enum([
  "want_category",
  "first_want_category",
  "unclassified",
]);
