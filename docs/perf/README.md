# Quality pass: list routes, outbound calls, memory

Issue #543 (MW-214). This is the review record; `services/ai` is out of scope here.

## Outbound calls

`fetchWithPolicy` in `packages/service-kit/src/http.ts` gives every outbound HTTP call a per-attempt
timeout (default 10 s) and bounded retries (default 2, exponential backoff, only for 429/502/503/504
and network errors). Non-idempotent calls (message sends, internal POSTs) are never retried, so a
retry cannot duplicate a message.

| Caller | Policy |
| --- | --- |
| notify Telegram API calls | timeout, no retry (sends are not idempotent) |
| notify Telegram file download | timeout, retry |
| notify Discord API calls | timeout, no retry |
| notify Discord attachment download | timeout, retry |
| notify wake-photo internal POSTs | timeout, no retry |

Remaining: `apps/dev-runner` event delivery and the `services/ai` clients (dev tooling and another
builder's scope).

## List routes

Entity stores are in-memory behind store interfaces and the database-backed ones key their lists by
`user_id`; no route loads a child row per parent row (no N+1 found in the reviewed handlers).

| Route | State |
| --- | --- |
| `GET /faults` (rules) | keyset-paginated, default 50, max 100 |
| `GET /inbox` (notify) | keyset-paginated, capped |
| `GET /admin/audit` (identity) | limit/offset, max 500; now defaults to 100 instead of unbounded |
| `GET /penalties` (rules) | per user, not paginated yet |
| `GET /consents/audit`, `/admin/incidents`, `/admin/invitations` (identity) | not paginated yet |
| `GET /budget/debts`, `/budget/wishlist`, `/budget/weekly-menu` (budget) | per user, not paginated yet |
| schedule list routes (`/templates`, `/recurrences`, `/routines`, ...) | per user, not paginated yet |

Paginating the remaining routes changes response shapes that `packages/contracts` defines, so it
needs an ADR and a follow-up issue.

## Memory

Measure with `node scripts/measure-rss.mjs <idle|e2e> <pid> --seconds 30`. It reads `VmRSS` and
compares the peak with the web container limit (256 MB, `infra/docker-compose.yml`).

| Phase | Peak RSS | Limit | Result |
| --- | --- | --- | --- |
| idle | to be recorded on the demo host | 256 MB | |
| end-to-end | to be recorded on the demo host | 256 MB | |
