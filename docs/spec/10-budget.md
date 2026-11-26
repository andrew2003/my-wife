# Budget service

Owner: `budget`. Source: `00-final-decisions.md`, `01-budget-details.md`, brainstorm "Feature 1". Numbers are settings in `02-defaults.md`. The bot never moves money; it only reads receipts to verify (principle 2). Every rule in this file is a pure function over data plus settings plus an injected clock, with table-driven tests.

## 1. Scope

The budget service owns: budget cycles, budget categories, bank accounts, the weekly plan (including menu and shopping list), the transaction ledger, reconciliation results, balance snapshots, learned payees and merchant rules, the debt ledger, the income pool, the wishlist, refunds and exceptions. It consumes `receipt.parsed` from ingest. It does not compute fault points or penalty amounts for monitoring or routines (that is `rules`), but it detects overspending and hands the facts to `rules`.

## 2. Entities

| Entity | Key fields |
| --- | --- |
| `budget_cycle` | `id`, `user_id`, `sequence` (1,2,3...), `weeks`, `first_day`, `state`, `opened_at`, `closed_at`, `commitment_id` |
| `budget_category` | `id`, `name`, `short_code` (unique per user, not reserved), `priority` (`need`/`should`/`want`/`fund`), `kind` (`fixed`/`variable`), `counts_toward_surplus`, `bank_account_id`, `cycle_limit_vnd`, `want_order` (for `want`) |
| `bank_account` | `id`, `name`, `code` (user-defined, for `MW-DC-...`), `kind` (`spending`/`penalty_savings`/`savings`), `email_notifications_confirmed` |
| `weekly_plan` | `cycle_id`, `week_index`, `limits[]`, `items[]`, `menu[]`, `shopping_list[]` |
| `planned_item` | `id`, `category_id`, `number` (01...), `amount_vnd`, `transfer_code`, `status` |
| `transaction` | `id`, `receipt_id`, `bank_account_id`, `direction` (`in`/`out`), `amount_vnd`, `occurred_at`, `memo`, `counterparty`, `transaction_type`, `reconciliation_result`, `category_id?`, `planned_item_id?`, `cycle_id`, `week_index`, `linked_transaction_id?`, `adjustment_of?` |
| `balance_snapshot` | `bank_account_id`, `balance_vnd`, `source` (`user`/`email`), `taken_at` |
| `debt` | `id`, `kind` (`receivable`/`payable`), `person`, `amount_vnd`, `settled_vnd`, `due_at?`, `state`, `funding_category_id?` |
| `income_pool_entry` | `id`, `amount_vnd`, `payer`, `received_at`, `allocated_cycle_id?` |
| `wishlist_item` | `id`, `name`, `price_vnd`, `saved_vnd` |
| `learned_payee` | `counterparty_key`, `category_id`, `scope` (`once`/`payee`/`payee_and_amount`), `amount_vnd?` |

Money is integer VND. Weekly limit of a variable category = `round_to(cycle_limit / cycle_weeks, weekly_limit_rounding_vnd)`; the last week of the cycle receives the remainder so the weekly limits sum to the cycle limit. `fund` categories have only a cycle limit and a cycle-level code.

## 3. Cycle state machine

States: `draft`, `awaiting_funds`, `running`, `closing`, `closed`.

| From | Event / trigger | Guard | To | Effects |
| --- | --- | --- | --- | --- |
| (none) | user starts the wizard (`cycle.draft_created`) | previous cycle is `closing` or `closed`, or none exists | `draft` | Ask "anything new?" and show last income pool and suggestion |
| `draft` | user approves plan and signs commitment | commitment contract signed (see `12-rules.md`) | `awaiting_funds` | Compute per-bank transfer amounts, issue transfer list with prefilled QR (amount and memo), emit `cycle.funds_requested` |
| `awaiting_funds` | receipts arrive | each account has verified incoming amounts at least its required amount | `running` | Emit `cycle.opened`; generate weekly plan codes |
| `awaiting_funds` | user lowers amounts | new amounts are a valid plan | `awaiting_funds` | Recompute required amounts; lowering is a structural change of this not-yet-open cycle, allowed |
| `awaiting_funds` | user abandons | none | `draft` | Nothing booked |
| `running` | last week closes (`week.closed` for the final week) | all weekly reconciliation done or deadlines passed | `closing` | Compute surplus, run exception and overspend settlement, emit `cycle.closing` |
| `closing` | surplus allocation applied and balance reconciliation done | no open `unknown` transactions older than deadline | `closed` | Emit `cycle.closed` with surplus split; archive; sync Sheet |

Rules:

- The wait for money is allowed; spending during `awaiting_funds` is booked to the previous cycle as `unplanned` with no penalty (logged decision).
- Structural changes (cycle length N, week start day) apply from the next cycle. Raising a `want` limit is loosening (locked until next week or cycle); lowering applies immediately. Changing `need` limits follows the same rule: raising is loosening only for `want`; raising a `need` limit takes effect from next week.
- A bank account may only hold categories if `email_notifications_confirmed` (a test receipt was received). Otherwise the cycle cannot leave `draft`.

## 4. Weekly plan

- At the start of each budget week the bot sends each category's weekly limit, the day-by-day menu and the shopping list.
- The user enters dishes and raw ingredients. The service spreads the menu over days, builds the week's shopping list and estimates cost (`plan.menu_estimate_enabled`). The LLM may propose the split and the estimate; the user approves; the planned items are stored by code.
- Every planned item has a transfer code `MW-C<sequence>W<week>-<categoryShortCode>-<nn>`, for example `MW-C07W2-AN-02` (cycle sequence 7, week 2, category `AN`, item 02). This replaces the ISO-week example in `01-budget-details.md`.
- Other codes: category short code (unplanned spend), `MW-DC-<fromAccount>-<toAccount>` (internal transfer), `MW-PH-C<sequence>W<week>-<categoryShortCode>` (penalty payment). User short codes must be unique and must not equal `DC`, `PH` or `MW`.
- Matching normalizes the memo (uppercase, strip diacritics and non-alphanumerics) and looks it up against the normalized set of issued codes. It never parses free text with the LLM.

## 5. Transaction classification

Each transaction gets one `transaction_type` and one `reconciliation_result`.

`transaction_type` enum: `planned_transfer`, `coded_unplanned`, `third_party_payment`, `foreign_card`, `subscription`, `internal_transfer`, `cycle_funding`, `penalty_payment`, `income`, `debt_repayment_in`, `debt_repayment_out`, `loan_out`, `loan_in`, `group_expense`, `refund`, `cash_withdrawal`, `credit_card_payment`, `bank_fee`, `unknown`.

`reconciliation_result` enum (from `01`): `matched`, `amount_mismatch`, `unplanned`, `unknown`, `wrong_bank`, `internal_transfer`, `not_executed`, `penalty_unpaid`, `adjusted`.

Precedence for a single transaction: `wrong_bank` > `amount_mismatch` > `matched`; an amount for an unplanned item is never `matched`. `not_executed` and `penalty_unpaid` apply to planned items or penalty entries with no receipt, not to transactions.

Tolerance: a coded planned transfer is `matched` iff `abs(actual - planned) <= max(planned * tolerance_percent / 100, tolerance_min_vnd)` (symmetric).

Assignment order (first hit wins): full code, category short code, learned payee or merchant rule, then ask the user. An `MW-` coded transaction is assigned directly and the user cannot relabel it (after the week is closed a relabel needs an appeal).

| Type | Detection | Handling |
| --- | --- | --- |
| `planned_transfer` | memo matches an issued planned-item code | Assign to the category and item; result `matched` or `amount_mismatch`; `wrong_bank` if the paying account does not hold the category |
| `coded_unplanned` | memo is a category short code or a learned payee | Result `unplanned`; counts against the category |
| `third_party_payment` | counterparty is a wallet or gateway (ShopeeFood, Grab) | Learn by counterparty; ask the first time |
| `foreign_card` | foreign currency, merchant like `GOOGLE*YouTube` | Book provisionally at the daily rate from the pluggable FX provider; the VND amount in the email wins; adjust when the final amount arrives (result `adjusted`); pair "authorization" with "debit" by `ingest.hold_match_window_hours` so it is never counted twice |
| `subscription` | same merchant, same amount, repeating `budget.subscription_min_occurrences` times | Propose converting to a fixed category |
| `internal_transfer` | out of account A and in to account B of the same user, equal amount, within `budget.internal_transfer_match_window_minutes`, or memo `MW-DC-...` | Pair into one `internal_transfer`; never an expense; an out-transfer to an undeclared own account must be declared, otherwise it is an expense |
| `cycle_funding` / `penalty_payment` | incoming money to the assigned account with the right code | Tick the transfer list, or clear the penalty ledger entry |
| `income` | inflow without a code from a payer | Ask the first time, learn the payer; goes to the income pool, never to the running budget; unresolved stays "unclassified income" and is not added to any budget |
| `debt_repayment_in` | inflow matching a receivable person and an outstanding amount (partial payments allowed) | Reduce the receivable; restore the funding category's limit; no match goes to the anomaly inbox |
| `refund` | inflow from a merchant previously paid | Link to the original; restore category limit, capped at the original amount; any excess is income |
| `cash_withdrawal` | ATM or counter withdrawal | Must be allocated to categories within `budget.cash_allocation_deadline_hours`; otherwise the unresolved amount goes to the fallback (see 7) |
| `credit_card_payment` | transfer paying a card statement | Not an expense, because each card transaction was already counted |
| `bank_fee` | fee or interest template | Automatic, category "bank fees" |

Quick-reply buttons for a question: pick a category, Internal transfer, Income, Refund, Not mine, and a remember scope (`once`, `payee`, `payee_and_amount`). "Not mine" has a quota (`budget.not_mine_quota_per_cycle`).

## 6. Debt ledger and income pool

| Situation | Recognition | Ledger | If unresolved |
| --- | --- | --- | --- |
| Lend to a friend | Outflow and the user presses "Lend" | Open `receivable` (person, amount, optional due date); funded temporarily from a chosen category, usually the contingency fund | After the due date: remind the user. After `debt.receivable_write_off_prompt_days`: ask "keep waiting or write off". A write-off becomes an expense of the funding category |
| Friend repays | Inflow matches person and outstanding amount | Reduce receivable; restore funding limit | No match: anomaly |
| Borrow | Inflow and the user presses "Borrow" | Open `payable`; not income. Spending the loan still counts against categories | On the due date, create a "Repay debt" task in the schedule checklist |
| Repay a loan | Outflow matches a payable | Close the payable; not an expense | none |
| Pay for a group | User presses "Group expense", enters head count or own share | Own share counts to the category; the rest becomes receivables per person | After `debt.group_expense_collect_days` the missing part is booked to the category automatically and may cause overspend and a penalty |
| Friend pays on my behalf | I transfer my share, ideally with an `MW-` code | Normal expense | Without a code, ask like any transaction |
| Income | Inflow from a learned payer | Income pool | none |

An overdue receivable that is not collected becomes an expense automatically (final decision). The bot only reminds the user; it never messages the user's friends.

Opening the next cycle: the wizard shows the income pool total and suggests a budget (keep as before, or by `budget.income_ratio_percent`) and a transfer table per account. Income not used by the new cycle is suggested to savings or future purchases. Late salary: the cycle stays in `awaiting_funds`.

## 7. Where unresolved money lands

Per `docs/decisions.md`: unknown spend after `budget.unknown_deadline_hours`, unallocated cash and overdue receivables are booked to the user's ordered `want` list (the first `want` category with room, else the first), falling back to a visible, appealable system category `unclassified`. Unresolved income stays "unclassified income".

## 8. Overspending, exceptions and surplus

- Week close: for each category, `excess = max(0, spent - weekly_limit)`. Spent includes appeal-adjusted amounts.
- `want`, `should`, `fixed` variable: overspend penalty = `penalty.overspend_percent` of the excess. The limit deduction is applied to the next week's limit of the same category (for the last week of a cycle, the first week of the next cycle's same category, if it exists; otherwise recorded as penalty debt). `budget` emits `overspend.detected`; `rules` creates the penalty ledger entry (see `12-rules.md`).
- `need`: by default (`penalty.need_overspend_mode` = `penalize`) overspend is penalized like other groups, with appeal allowed, and the bot may propose a limit raise. With `warn_only` it raises a warning and an optional limit-raise proposal, and no penalty.
- Exceptions: up to `budget.exceptions_per_cycle` per cycle, claimed by the user before the week closes; the excess is funded from the contingency fund and is not penalized. The contingency fund balance cannot go below zero.
- Surplus at cycle end = sum of positive remainders (limit minus spent) of categories with `counts_toward_surplus` on; fixed categories never contribute. Split: `surplus_share_savings_percent` to savings, `surplus_share_future_purchases_percent` to future purchases, remainder to `surplus_remainder_target`. Rounding: the remainder takes the leftover VND so the shares sum exactly.
- Penalty savings is separate: penalties never count toward fixed savings contribution or the surplus split.

## 9. Balance reconciliation (backstop)

Weekly, on `budget.balance_reconciliation_weekday`, the user enters each account balance (or the service uses a balance parsed from an email). `expected = previous_snapshot + inflows - outflows` for transactions since that snapshot. If `abs(actual - expected) > balance_tolerance_vnd`, the difference becomes a `missing_receipt` anomaly in the inbox. For an outflow gap the user must allocate it; unresolved it follows rule 7. For the penalty savings account, any outflow other than the penalty rules is a `penalty_savings_withdrawal` violation (raised to `rules`).

## 10. Wishlist

Each item has a price and progress. Estimated cycles remaining = `ceil((price - saved) / contribution_per_cycle)` where contribution is the average funding of the future-purchases category over completed cycles (or the planned amount before any cycle). If the contribution is 0 the estimate is "unknown".

## 11. Events

Published: `cycle.draft_created`, `cycle.funds_requested`, `cycle.opened`, `cycle.closing`, `cycle.closed`, `plan.week_published`, `txn.recorded`, `txn.reclassified`, `txn.adjusted`, `overspend.detected`, `exception.used`, `anomaly.opened` (carries a question for notify), `anomaly.resolved`, `balance.discrepancy_found`, `penalty_savings.withdrawal_detected`, `debt.opened`, `debt.overdue`, `debt.written_off`, `income.recorded`, `surplus.allocated`, `ask.budget_category` (question with buttons).

Consumed: `receipt.parsed`, `receipt.unknown` (opens an anomaly), `penalty.issued` / `penalty.paid` (to tick lists), `week.closed` from schedule (shared week boundary), `user.updated`.

## 12. Acceptance (examples; issues expand these)

1. Given a variable category with cycle limit 4,000,000 and 4 weeks, When the plan is built, Then weekly limits are 1,000,000 each; with limit 1,000,500 over 3 weeks they are 333,000, 333,000 and 334,500.
2. Given a planned item of 100,000 and tolerance 5% min 10,000, When 109,000 arrives with the code, Then the result is `matched`; When 111,000 arrives, Then `amount_mismatch`.
3. Given a category paid from an account that does not hold it, When the receipt is processed, Then the result is `wrong_bank` even if the amount matches.
4. Given an `unknown` transaction, When 24 hours pass without an answer, Then it is booked to the first `want` category in the user's order and the user is told.
5. Given an `awaiting_funds` cycle with one account short, When all accounts have verified receipts, Then the cycle becomes `running` and emits `cycle.opened` once.
6. Given a `want` category over its weekly limit by 50,000, When the week closes, Then `overspend.detected` carries excess 50,000 and next week's limit is reduced by 50,000.
7. Given a refund of 300,000 against an original of 200,000, Then 200,000 is restored to the category and 100,000 is income.
8. Given a receivable overdue by more than `debt.receivable_write_off_prompt_days` and not written off by the user, When the prompt is ignored, Then it is booked as an expense under rule 7 on the next week close.
