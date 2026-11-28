import { RecordCashExpenseRequestSchema } from "@my-wife/contracts";
import { postJson } from "./http";

/**
 * The budget route that records a cash spend the user reports. The bot never moves money: this
 * writes a spend fact through the same validation as the web form.
 */
export const CASH_EXPENSE_PATH = "/budget/cash-expenses";

export interface CashExpenseInput {
  amountVnd: number;
  categoryId?: string;
  note?: string;
  occurredAt?: string;
}

export interface BudgetClient {
  recordCashExpense(userId: string, input: CashExpenseInput): Promise<unknown>;
}

export function createBudgetClient(baseUrl: string, fetchFn: typeof fetch = fetch): BudgetClient {
  return {
    async recordCashExpense(userId, input) {
      const body = RecordCashExpenseRequestSchema.parse(input);
      return postJson(fetchFn, "budget", `${baseUrl}${CASH_EXPENSE_PATH}`, userId, body);
    },
  };
}
