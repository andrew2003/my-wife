# ADR 0001: Microservices in one monorepo

- Status: accepted
- Date: 2026-11-26

## Context

The product has ten bounded domains (gateway, identity, budget, ingest, schedule, monitor, rules, ai, notify, sync) plus a web app. Agents build in parallel and need hard boundaries, but the team is one owner on one 16 GB machine.

## Decision

- Ten services, one Next.js PWA, shared packages, all TypeScript, in one monorepo managed by pnpm workspaces and Turborepo.
- Each service is its own package with its own Dockerfile and is deployed as its own container for the demo.
- Services share code only through `packages/*`; `packages/contracts` is the only place where APIs, events and enums are defined (see ADR 0010).
- A service never reads another service's database schema.

## Consequences

- Clear ownership per issue and per agent; small PRs.
- Operational cost stays low because development runs all services in one process (ADR 0007).
