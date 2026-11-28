# ADR 0021: Profile and read-route schemas move into contracts

Status: accepted (2026-11-28). Changes `packages/contracts` (settings registry, commands). Closes the exception in ADR 0014 item 8 (issue #538).

## Context

ADR 0014 kept some shapes local to `apps/web` until the server sides were stable. The inbox, faults, penalties and keys read routes already use schemas from contracts. What remained local: the settings envelope (copied in four web files), the appearance and expression settings, the persona lists and the custom command list. The appearance and persona keys were not registered, so identity would refuse to store them.

## Decision

- New `settings/profile.ts` holds `SkinSchema`, `ThemeModeSchema`, `ExpressionKeySchema`, `ExpressionSetSchema`, `ExpressionStateSchema`, `ExpressionMapSchema`, `PersonaTermSchema` and `PersonaListSchema`.
- The registry gains `appearance.skin`, `appearance.mode`, `appearance.expression_set`, `appearance.expression_map` and `persona.address_user`, `persona.self_reference`, `persona.wife_label` (owner `web`, scope `user`), with the defaults of `docs/spec/02-defaults.md`.
- Persona defaults are empty lists. The default texts are Vietnamese and English words that live in locale files; web treats a persona value with both locales empty as "not customised" and uses the locale defaults.
- `commands/entities.ts` gains `ListCustomCommandsResponseSchema`; the ai route and web parse with it.
- Web reads the settings response with `GetSettingsResponseSchema` and deletes its local envelope copies.

## Consequences

- Additive only: new keys and a new schema; no existing shape changes.
- Web and the producing services import one definition. Identity now accepts the appearance and persona keys.
