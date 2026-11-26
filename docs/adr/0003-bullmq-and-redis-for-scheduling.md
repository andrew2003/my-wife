# ADR 0003: BullMQ and Redis for scheduled work

- Status: accepted
- Date: 2026-11-26

## Context

Many behaviors are time-driven: week close, deadlines (24 hours for unknown spend), digests, wake-up nudges, token refresh, sync debounce.

## Decision

- Delayed and repeating jobs run on BullMQ with one Redis instance (128 MB limit).
- Job handlers call pure business functions that take `now` as a parameter. Jobs only decide when to call, never what the rule is.
- Job payloads carry ids, not data, and handlers are idempotent.

## Consequences

- Time can be simulated in tests by injecting the clock.
- Redis holds no business truth; losing it means re-deriving jobs from the database.
