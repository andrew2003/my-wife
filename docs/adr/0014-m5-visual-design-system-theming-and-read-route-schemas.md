# ADR 0014: M5 visual design system, theming and read-route schemas

Status: accepted (2026-11-28); open questions decided by the po, see `docs/decisions.md`

## Context

The owner did not accept M4 because the web app looks unfinished, mixes languages after a switch, and shows empty screens in the manual demo. Milestone M5 (see `factory/prompts/milestones.md`) redesigns the web app, adds light and dark themes, fixes the locale bugs and routes the missing API paths. The full design is in `docs/design/m5-design-plan.md`. This ADR records the decisions that other work depends on. `packages/contracts` is not changed by this ADR.

## Decision

1. **Design system.** Plain CSS custom properties (design tokens) in one global stylesheet plus CSS Modules per component. No Tailwind, no CSS-in-JS, no animation library, no component library. Tokens and the light and dark palettes are the ones in the design plan; their contrast is checked by a pure function over the token table (a unit test), not by eye.
2. **Theming.** Choices are `light`, `dark`, `system`. Stored in the cookie `mw_theme` (not HttpOnly because the client control writes it, `SameSite=Lax`, `Path=/`, one year, no personal data). The root layout reads it per request and sets `data-theme` on `<html>` (`light` or `dark`; `system` sets no attribute and CSS uses `prefers-color-scheme`). No inline script and no flash.
3. **Locale.** Every page, `generateMetadata`, `manifest.ts` and client component takes the request locale. `UI_LANGUAGE` is read only as the default when no `mw_locale` cookie exists. `/locale` redirects to a validated same-origin relative path; it sets only the cookie (no profile write). `manifest.ts` uses the default locale on purpose, because the browser fetches it without user context. The switch control is a segmented `VI | EN` control showing the current language.
4. **Fonts and art.** Fonts are committed OFL files served through `next/font/local`. The background art is a one-off, locally produced cut-out committed as an optimized asset; no image tool becomes a repository dependency and no model weights are committed. Mascot moods are exactly `calm`, `thinking`, `oops`; fonts are Be Vietnam Pro 400 and 600 only.
5. **Navigation.** Five areas and a mobile bottom bar with a "More" sheet, as in the plan. Admin items are hidden for non-admins.
6. **Read-route shapes stay local.** The new read routes (notify inbox, rules faults, ai keys list) keep zod schemas local to `apps/web` (`lib/api-shapes/`), validated at the edge, as earlier web screens did. We do not add them to `packages/contracts` now, because the server side of these routes is still being built in the same milestone and the shapes may change. Follow-up, tracked as a GitHub issue in the M5 backlog: once the routes are stable, a separate ADR moves the shapes to contracts, and the owning service imports them. Until then each local schema carries a comment naming the producing service route and a test fixture that the producing service test also uses (same JSON file under `apps/e2e/fixtures/`), so drift fails a test.
7. **Gateway wiring.** The gateway gets per-prefix routes and upstream URL environment variables for `ai`, `notify`, `ingest` and `monitor`, with one test per prefix. The new variables are recorded in `docs/decisions.md`. A route that no service serves yet (rules `GET /faults`, notify `GET /inbox`) is built in the owning service first; the gateway never answers it itself.

## Consequences

- The web container keeps its 256 MB limit and 192 MB heap cap; features give way before the limit is raised, and raising it needs an ADR.
- No new runtime dependency in the web app: fonts and images are static files. Memory cost is small (see the plan).
- Cookie `mw_theme` makes pages dynamic; they already are (the layout is `force-dynamic`).
- Local shapes duplicate knowledge until the follow-up ADR; the shared fixture limits the risk.
- A second visual change later only touches tokens, not components.
