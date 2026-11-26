# Budget details

These details were agreed in the brainstorm spreadsheet and are not fully covered by the source document. Every number is a default example.

## Budget categories

- Each category has: a name, a priority (`need` / `should` / `want` / `fund`), the bank account that holds its money, a cycle limit, a kind (fixed or variable), and a "counts toward surplus" flag.
- The weekly limit of a category is its cycle limit divided by the number of weeks in the cycle, rounded to the nearest 1,000 VND. `fund` categories are not split by week.
- The surplus at the end of a cycle is the sum of the positive remaining amounts of the categories whose "counts toward surplus" flag is on. Fixed categories never produce surplus.
- The surplus is split by user-set shares: x% to savings, y% to future purchases, and the remainder as the user directs.
- Sample category set: food, fixed bills, transport, health and personal care, eating out and delivery apps, entertainment, small shopping, contingency fund, savings, future purchases, penalties.
- Wishlist: each item has a price and progress; the bot estimates how many cycles remain until it is affordable at the current contribution per cycle.

## Bank accounts

- The number of bank accounts is unlimited. Each account holds a group of categories.
- Before each cycle the bot computes the amount to transfer into each account: the sum of the cycle limits of the categories it holds.
- Spending a category from an account that does not hold it is recorded as `wrong_bank`.

## Transfer codes

| Code | Meaning |
| --- | --- |
| `MW-<week>-<category>-<number>`, for example `MW-W48-AN-02` | A planned expense of the weekly plan: item 02 of the category with short code `AN` |
| A category short code, for example `GT`, `MS` | An unplanned expense assigned directly to that category |
| `MW-DC-<from>-<to>`, for example `MW-DC-NH1-NH3` | An internal transfer between two of the user's own accounts |
| `MW-PH-<week>-<category>`, for example `MW-PH-W48-AN` | A penalty payment for that week and category |

Category short codes and account codes are user-defined data, so they stay as the user typed them.

Matching order for a transaction: full code, then category short code, then a learned payee or merchant, and finally ask the user.

## Reconciliation results

Each transaction gets exactly one result:

| Result (enum) | When |
| --- | --- |
| `matched` | Correct code and the amount is within the tolerance (default ±5%) of the plan |
| `amount_mismatch` | Correct code but the amount is outside the tolerance |
| `unplanned` | Has a category short code or a learned payee, but is not in the weekly plan |
| `unknown` | Not recognized; ask the user. After the deadline (default 24 hours) it counts toward a `want` category |
| `wrong_bank` | A category was paid from an account that does not hold it |
| `internal_transfer` | Money moved between the user's own accounts |
| `not_executed` | A planned item with no receipt yet |
| `penalty_unpaid` | A penalty is due and no payment receipt has arrived |
| `adjusted` | Changed after an appeal, a refund, or the final VND amount of a foreign-currency transaction |

## Sample email receipt (Vietcombank)

- Contains: transaction reference (used for deduplication), source account (identifies the bank account), beneficiary, total amount, transfer memo, timestamp.
- Does not contain: line items. QR payments usually carry a default memo, so the payee must be learned.

## Sheet per cycle

The bot creates a new spreadsheet for each cycle from a template the user approved, in a folder the user granted access to. Tabs: budget categories, bank accounts, weekly plan, transaction ledger, surplus and goals. Data is pushed one way from the database; the user edits in the web app.

## Weekly plan and menu

- The user enters dishes and raw ingredients. The bot spreads the menu over the days, builds the shopping list for the whole week and estimates the cost.
- Each planned item in the weekly plan has a ready transfer code and amount, so that paying it matches immediately.
