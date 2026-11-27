# ADR 0013: Planned items travel on `week.planned`

Status: accepted (2026-11-27)

## Context

`POST /budget/weekly-plan` (#307) publishes the planned items of a week into the budget record, but no event carried the items, so nothing called it (#310). The weekly plan is approved in `schedule` (`POST /weeks/:id/approve`), which emits `week.planned` with only `weekId` and `firstDay`. ADR 0010 requires an ADR for every change to `packages/contracts`.

## Decision

- `week.planned` gains an optional `plannedItems: { categoryId, amountVnd }[]` (integer VND, non-negative). `WeekPlannedItemSchema` is exported from contracts.
- `schedule` accepts the same optional list in the body of `POST /weeks/:id/approve`, validates it with the schema, and copies it into the event. It does not interpret it.
- `budget` consumes `week.planned`. It derives the week index from the cycle's `firstDay` and the event's `firstDay`, then runs the same publisher as the route. Budget issues item numbers and transfer codes and checks categories and amounts; nothing from schedule is trusted.
- A week outside the cycle, without items, for a missing or non-running cycle, or already published is ignored, so redelivery is idempotent.
- The change is additive: consumers that ignore the field keep working.

## Consequences

- No new event type and no new service-to-service call. The stored items stay owned by `budget`.
- A request schema for the route is still not in contracts; that remains a follow-up.
