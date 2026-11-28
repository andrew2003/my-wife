# ADR 0020: Command overrides setting

Status: accepted (2026-11-28). Completes ADR 0016 for the command settings screen (#539).

## Decision

`packages/contracts` registers the user setting `commands.overrides`: an array of `CommandOverrideSchema` entries (per-user edits of built-in commands: enabled, name, aliases, description), at most 100 entries, default `[]`, owner `ai`, as listed in `docs/spec/02-defaults.md`. Without a registry entry, identity refuses to store the key. Existing settings and events are unchanged.

## Consequences

The web command settings screen reads and writes the key through `/api/settings`. `ai` and `notify` read it when building the per-user command registry (a follow-up; ai keeps command settings in memory today).
