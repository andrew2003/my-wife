# ADR 0017: Keys list pagination cursor

Status: accepted (2026-11-28). Changes `packages/contracts` (identity API).

## Context

The ai service route `GET /keys` is keyset-paginated (issue #501) and returns an opaque `nextCursor`. `ListKeysResponseSchema` in `packages/contracts` did not describe it, so the shared schema and the route disagreed. ADR 0014 keeps read-route shapes local to `apps/web` for this milestone; this change only closes the gap for the schema that already lives in contracts.

## Decision

`ListKeysResponseSchema` data gains `nextCursor`: a non-empty string, or `null` on the last page. It defaults to `null` when omitted, so existing producers and consumers keep parsing. The cursor is opaque to clients. Key views stay strict and never carry key material.

## Consequences

- The route output parses with the shared schema; a table-driven test covers cursor, null, omitted and invalid cases.
- No breaking change: the field is additive with a default.
