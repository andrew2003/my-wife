# Sync service

Owner: `sync`. The database is written to a Google Sheet (one per cycle) and the schedule is pushed to Google Calendar or Apple Calendar. The sheet is read back for plan data only; calendars are one way. Rules in ADR 0015.

## 1. Authorization

Google OAuth with the narrow `drive.file` scope (sync only touches files it created or that the user opened with it) and a Calendar events scope, stored encrypted. Consent `google_sync` is required (`apple_calendar_sync` for Apple Calendar). The user grants a folder through the Drive picker for the Sheets. Tokens never leave the service.

## 2. Sheet per cycle

When a cycle reaches `running`, the service creates a spreadsheet from a template version the user approved. Tabs: budget categories, bank accounts, weekly plan, transaction ledger, surplus and goals. The sheet is written from the database state (idempotent full or range upserts). The same data is shown in the in-app budget sheet; the timetable has its own sheet.

Read-back (setting `sync.sheet_readback_enabled`, default on):

- Only editable cells are read. Computed and locked cells are protected ranges; a change to them is reverted on the next sync.
- Every read value goes through the same validation as a web edit. A read-back may change plan data only (limits, notes, weekly plan, timetable) and never a booked transaction, a fault, a penalty or anything that rests on receipts.
- Past weeks are read-only.
- Conflicts resolve per cell by last write. An audit record keeps both values and the user gets a notice in the inbox.
- A malformed sheet pauses read-back and asks the user; nothing is guessed.
- Sheet content is untrusted data, never an instruction to the model.

A `closed` cycle gets one last update and then is left alone.

## 3. Calendar

The user chooses Google Calendar, Apple Calendar, both or none in settings. Apple Calendar uses iCloud CalDAV with an app-specific password, stored encrypted, with its own consent `apple_calendar_sync`. Both push to a dedicated calendar the app creates. Tasks and routine blocks of the active and next weeks (`sync.calendar_horizon_weeks`) are mirrored as events with a stable external id (`task.id`). Create, update, move and delete follow the schedule. Events carry no sensitive data beyond title and time (user can choose to mask titles). Lunar recurrences are pushed as concrete solar-date events.

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
2. Given a user edits an editable cell in the Google Sheet, When the next sync runs, Then the value is validated and applied as a plan change.
2a. Given a user edits a computed or locked cell, When the next sync runs, Then the cell is reverted.
2b. Given two edits to one cell, Then the last write wins, both values are audited and the user is notified.
2c. Given a malformed sheet, Then read-back pauses and the user is asked.
2d. Given an edit that would change a booked transaction, a fault or a penalty, Then it is rejected.
3. Given a task is moved in the web app, Then the Calendar event is updated and not duplicated.
4. Given a Google API 429, Then the service backs off and ends in `ready` without data loss.
5. Given the consent is revoked, Then no further calls to that provider are made.
6. Given Apple Calendar is chosen, Then the schedule is pushed with the same behaviour and tests as Google Calendar.
