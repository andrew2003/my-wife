# ADR 0012: Response schema of the budget overview

Status: accepted (2026-11-27)

## Context

The `/budget` page reads `GET /budget/overview` (MW-029, #40). The shape was recorded in `docs/decisions.md` but `packages/contracts` has no schema for it, so the web and the `budget` service each defined their own copy. ADR 0010 requires an ADR for every change to `packages/contracts`. Issue #247 allows this change.

## Decision

- `packages/contracts/src/budget/api.ts` gains `CategoryStatusSchema`, `AnomalyViewSchema` and `BudgetOverviewResponseSchema`.
- The data is `{ cycle, weekIndex, bankAccounts, categories, transactions, anomalies }`. A category row is `{ category, weeklyLimitVnd, spentVnd, remainingVnd }`; an anomaly is `{ id, kind, subjectRef }`.
- Existing schemas are not changed. The change is additive.

## Consequences

- `budget` builds the response and the web parses it with the same schema.
- Dates stay UTC instants; the web shows them in the user's `calendar.time_zone`.
