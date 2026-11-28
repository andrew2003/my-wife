# ADR 0018: Sync read-back and calendar schemas

Status: accepted (2026-11-28). Implements point 4 of ADR 0015.

## Decision

The schemas listed in ADR 0015 land in `packages/contracts` as specified, with these concrete shapes:

- `CalendarProviderSchema`: `google` | `apple`. `SyncTargetSchema` is unchanged (`sheets`, `calendar`); the provider is chosen separately.
- `CellEditRequestSchema` and `CellEditResponseSchema`: sheet kind (`timetable` | `budget`), tab, cell reference, optional entity id, field and a scalar value (string, number, boolean or null). The response is `applied` or `rejected` with a reason (`locked_cell`, `past_week`, `validation_failed`, `booked_fact`, `readback_disabled`).
- `ReadbackConflictRecordSchema`: both values, both change times, the winner (`app` | `sheet`) and the resolution time.
- Events published by `sync`: `sync.readback_applied`, `sync.readback_reverted`, `sync.conflict_resolved`, `sync.readback_paused`. Existing events are unchanged.
- Consent kind `apple_calendar_sync` is added to `ConsentKindSchema` (seven consents).
- Setting `sync.sheet_readback_enabled` (boolean, default true) is registered, as ADR 0015 requires.

The reject reasons and pause reasons are additions that ADR 0015 left open. They are enums so a new reason needs a contract change.

## Consequences

Services must handle the new consent kind; existing consents and events keep their shape.
