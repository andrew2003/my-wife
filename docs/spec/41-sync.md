# Sync service

Owner: `sync`. One-way mirrors from the database to Google Sheets (one per cycle) and Google Calendar (the schedule). The web app is where users view and edit; the mirrors are never read back, so the two never disagree.

## 1. Authorization

Google OAuth with the narrow `drive.file` scope (sync only touches files it created or that the user opened with it) and a Calendar events scope, stored encrypted. Consent `google_sync` is required. The user grants a folder through the Drive picker for the Sheets. Tokens never leave the service.

## 2. Sheet per cycle

When a cycle reaches `running`, the service creates a spreadsheet from a template version the user approved. Tabs: budget categories, bank accounts, weekly plan, transaction ledger, surplus and goals. The sheet is rewritten from the database state (idempotent full or range upserts); edits made in the sheet are ignored and overwritten. A banner row says so. A `closed` cycle gets one last update and then is left alone.

## 3. Calendar

Tasks and routine blocks of the active and next weeks (`sync.calendar_horizon_weeks`) are mirrored as events with a stable external id (`task.id`). Create, update, move and delete follow the schedule. Events carry no sensitive data beyond title and time (user can choose to mask titles). Lunar recurrences are pushed as concrete solar-date events.

Importing existing Google Calendar events as busy blocks is after the demo.

## 4. Sync state machine (per link)

`unlinked` -> `linking` -> `ready` -> `syncing` -> `ready` | `error`; `revoked`.

| From | Trigger | To |
| --- | --- | --- |
| `unlinked` | user starts authorization | `linking` |
| `linking` | token stored and test write OK | `ready` |
| `ready` | domain event arrives | `syncing` after `sync.debounce_seconds` of quiet |
| `syncing` | success | `ready` |
| `syncing` | API error | `error`, retry with `sync.retry_backoff_seconds` |
| `error` | retries exhausted | `error` visible in settings and a notification; the next event retries |
| any | token revoked or consent revoked | `revoked`; no further writes |

Writes are idempotent; rate limits (HTTP 429) are respected by backoff. A mapping table records `entity id -> external id`.

## 5. Events

Consumed: `cycle.opened`, `cycle.closed`, `txn.recorded`, `txn.adjusted`, `plan.week_published`, `surplus.allocated`, `task.*`, `week.planned`, `routine.block_placed`, `consent.revoked`, `user.updated`.

Published: `sync.sheet_created`, `sync.synced`, `sync.failed`, `sync.link_revoked`.

## 6. Acceptance

1. Given a cycle becomes `running`, Then a Sheet with all tabs exists in the granted folder and a `sync.sheet_created` event is emitted.
2. Given a user edits a cell, When the next sync runs, Then the cell is overwritten from the database.
3. Given a task is moved in the web app, Then the Calendar event is updated and not duplicated.
4. Given a Google API 429, Then the service backs off and ends in `ready` without data loss.
5. Given the consent is revoked, Then no further Google calls are made.
