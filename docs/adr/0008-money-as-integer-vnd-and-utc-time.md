# ADR 0008: Money as integer VND, time in UTC

- Status: accepted
- Date: 2026-11-26

## Context

Penalties and reconciliation must be exact and reproducible.

## Decision

- Money is an integer number of VND everywhere (`VndAmount` in contracts: a safe integer). No floats, no decimals. Percentages are applied by pure functions with a documented rounding rule; the remainder goes to the last share.
- Foreign-currency amounts are carried as an integer minor-unit amount plus an ISO currency code until converted.
- Time is stored and transmitted in UTC as ISO 8601 strings and shown in the user's time zone (`calendar.time_zone`). Business code takes `now` as a parameter and never reads the clock.

## Consequences

- Table-driven tests can fix time and amounts.
