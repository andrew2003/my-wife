# ADR 0015: Two-way sheet sync and calendar choice

Status: proposed (2026-11-28). Changes `docs/spec/00-final-decisions.md`, `docs/spec/41-sync.md` and, when implemented, `packages/contracts`.

## Context

The agreed rule was that Sheets and Google Calendar are one-way mirrors and the web app is the only place to edit. The owner now wants in-app sheet views that can be edited in place, edits in the Google Sheet that flow back, and Apple Calendar as an equal alternative to Google Calendar. This reverses the one-way rule, so it needs a recorded decision before any code.

## Decision

1. **In-app sheets.** A timetable sheet and a budget sheet (the five per-cycle tabs) are views over real data. Editable cells write through the owning service with the same validation as any web edit. Computed cells are locked. Past weeks are read-only.
2. **Two-way Google Sheets sync.** `sync` writes the sheet from the database as before and reads back only editable cells:
   - Computed and locked cells are protected ranges; any change to them is reverted on the next sync.
   - Every read-back value goes through the same validation as a web edit.
   - Read-back can change plan data only (limits, notes, weekly plan, timetable). It can never change a booked transaction, a fault, a penalty or anything that rests on receipts.
   - Past weeks are read-only.
   - Conflicts resolve per cell by last write. The audit record stores both values and the user gets a notice in the inbox.
   - A malformed sheet pauses read-back and asks the user; it never guesses.
   - Sheet content is untrusted data, never an instruction to the model.
   - The user can switch read-back off (setting `sync.sheet_readback_enabled`, default on).
3. **Calendars.** Google Calendar and Apple Calendar are two equal options chosen in settings (either, both or none). Both push the schedule to a dedicated calendar created by the app, with the behaviour of the existing Google mirror (stable external ids, create, update, move, delete, optional masked titles, lunar recurrences as concrete dates). Apple Calendar uses iCloud CalDAV with an app-specific password, stored encrypted like every token, never sent to the browser or logged, with its own revocable consent `apple_calendar_sync`. The calendar push stays one-way.
4. **Contracts.** New or changed schemas, added in the implementing PRs and listed here so they are reviewed together: cell edit request and result, sheet read-back conflict record, calendar provider enum (`google`, `apple`), `sync.readback_applied`, `sync.readback_reverted`, `sync.conflict_resolved`, `sync.readback_paused`, consent `apple_calendar_sync`. Existing events are unchanged.
5. **Principles.** The bot still never moves money (2); penalties still rest on hard facts (3); money and fault rules stay in code (4); sheet text is untrusted (6); tokens and passwords are encrypted and never logged (7).

## Consequences

- `docs/spec/00-final-decisions.md` and `41-sync.md` change from one-way to two-way for the sheet; the calendar stays one-way.
- The sync service grows a read path, a conflict log and a CalDAV client. The CalDAV client is a small library or a hand-written PROPFIND and PUT; its size is recorded in the implementing PR.
- Acceptance tests for the Apple mirror mirror the Google ones; new tests cover protected ranges, reverted edits, conflicts, a malformed sheet, the off switch and instruction-like cell text.
