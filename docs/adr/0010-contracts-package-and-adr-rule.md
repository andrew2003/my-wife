# ADR 0010: packages/contracts is the single source of truth, changes need an ADR

- Status: accepted
- Date: 2026-11-26

## Context

Ten services and a web app must agree on APIs, events and enums. Silent drift is the main integration risk.

## Decision

- `packages/contracts` (`@my-wife/contracts`) holds zod schemas and inferred types for every enum, REST request and response, and NATS event, plus the event subject registry and the settings registry.
- Layout: one folder per service in `src/`, kebab-case files, one `index.ts` barrel; shared primitives in `src/common`.
- This ADR authorizes the initial creation of the package from the M0 specs.
- Every later change to the package (new or changed schema, enum value, event, setting) needs a short ADR in `docs/adr/`, or an addendum to a related ADR. CI and reviewers reject contract changes without one.
- Contracts contain no business logic; the only values are enum members and setting defaults taken from `docs/spec/02-defaults.md`. Business code reads settings; it never hard-codes them.
- The LLM never writes to the ledger: contracts for `ai` tools expose only the tools in `30-ai.md`.

## Consequences

- Breaking changes are explicit and reviewable.
