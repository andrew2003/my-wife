# ADR 0009: User-facing text lives in locale files

- Status: accepted
- Date: 2026-11-26

## Context

Users speak Vietnamese; the repository is English only.

## Decision

- All UI strings and bot messages live in locale files `vi` and `en`. The default comes from `UI_LANGUAGE` (Vietnamese).
- Services emit a message key plus parameters (`MessageRef` in contracts); text is rendered at delivery or in the web app.
- Contracts expose stable enum values and keys, never display text.

## Consequences

- Missing keys fail a lint check; no Vietnamese text outside `docs/source` and the `vi` locale files.
