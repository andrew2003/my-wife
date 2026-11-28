# ADR 0002: Internal REST for queries, NATS JetStream for events

- Status: accepted
- Date: 2026-11-26

## Context

Services need synchronous reads (for example the `ai` tools reading budget status) and asynchronous facts (for example `receipt.parsed`, `fault.detected`).

## Decision

- Queries and commands between services use internal REST over HTTP with JSON bodies validated by the zod schemas in `packages/contracts`.
- Facts are published as events on NATS JetStream. Subjects are `<domain>.<past_tense>` in lowercase with dots, for example `receipt.parsed`. The registry `EVENT_REGISTRY` in `packages/contracts` is authoritative.
- Every event is wrapped in one envelope: `id`, `type`, `occurredAt`, `userId`, `schemaVersion`, `payload`. Consumers are idempotent on `id`.
- Parallel checkouts isolate through a subject prefix, never through a second NATS.

## Consequences

- No hidden coupling through shared tables.
- Event payload changes are contract changes and need an ADR.
