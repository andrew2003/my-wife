# ADR 0019: Calendar providers setting

Status: accepted (2026-11-28). Implements the calendar choice of ADR 0015.

## Decision

`packages/contracts` registers the user setting `sync.calendar_providers`: an array of `CalendarProviderSchema` values (`google`, `apple`), at most two entries, default `[]` (none), as already listed in `docs/spec/02-defaults.md`. An empty array means no calendar receives events; one or both entries select the receiving providers. Existing settings and events are unchanged.

## Consequences

`sync` reads the setting per user and pushes events only to the chosen providers. Duplicate entries are tolerated and pushed once.
