# ADR 0011: Need-group overspend defaults to penalize

Status: accepted (2026-11-26)

## Context

Q-0001 asked whether overspending a `need` category is penalized. The owner answered yes, with appeal allowed (see `docs/decisions.md`). ADR 0010 requires an ADR for every change to `packages/contracts`.

## Decision

- The default of the setting `penalty.need_overspend_mode` in the settings registry changes from `warn_only` to `penalize`. The enum members are unchanged.
- `penalize` applies `penalty.overspend_percent` to the excess, like other groups. `warn_only` stays selectable per user.
- Specs `02-defaults.md`, `10-budget.md` and `12-rules.md` are updated to match.

## Consequences

- `computeOverspendPenalty` must penalize `need` by default; its table-driven tests cover both modes.
- Existing stored user values are not affected; only the default changes.
