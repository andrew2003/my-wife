# ADR 0004: One PostgreSQL, one schema per service, Drizzle ORM

- Status: accepted
- Date: 2026-11-26

## Context

One machine, low memory, ten services, and per-user data isolation is a hard requirement.

## Decision

- A single PostgreSQL instance (with pgvector, 512 MB limit); one schema per service, owned and migrated by that service only.
- Drizzle ORM with SQL migrations kept in the owning service.
- Every table has `user_id` and PostgreSQL row-level security. The service sets the verified user id on the connection per request.
- Tables and columns are `snake_case`. Parallel checkouts isolate through a per-branch database name.
- One master key from an environment variable encrypts secrets (AES-256-GCM) with a `key_id` column for rotation.

## Consequences

- No cross-schema joins; data crosses services through REST or events.
- A RLS test per service proves user A cannot read user B.
