# ADR 0014: M5 design system, skins, private art and read-route schemas

Status: accepted (2026-11-28)

## Context

The web app looks unfinished, mixes languages after a switch, and shows empty screens in the manual demo. The M5 redesign adds four skins with light and dark modes, fixes the locale bugs and routes the missing API paths. The full design is in `docs/design/m5-design-plan.md`. Two-way sync and chat commands change contracts and have their own ADRs (0015, 0016). `packages/contracts` is not changed by this ADR.

## Decision

1. **Design system.** Plain CSS custom properties (`--mw-*`) generated from one TypeScript token table, plus CSS Modules. No Tailwind, CSS-in-JS, animation library or component library. Contrast of every pair in 4 skins x 2 modes is checked by a pure function over the table.
2. **Skins and modes.** Skins are `navy` (default), `hanfu`, `silver`, `street`; modes are `light`, `dark`, `system`. They are stored in the cookies `mw_skin` and `mw_mode` (not HttpOnly because the client control writes them, `SameSite=Lax`, `Path=/`, one year) and mirrored to the profile as `appearance.skin` and `appearance.mode`. The root layout sets `data-skin` and `data-mode` per request; `system` sets no mode attribute and CSS uses `prefers-color-scheme`. No inline script and no flash. One global setting drives every screen.
3. **Locale.** Every page, `generateMetadata` and client component takes the request locale. `UI_LANGUAGE` is read in one file as the fallback. `/locale` redirects to a validated same-origin relative path and sets only the `mw_locale` cookie. `manifest.ts` uses the default locale because the browser fetches it without user context. The switch is a segmented `VI | EN` control showing the active language. A user's language also stays a cookie-only choice (no profile write).
4. **Fonts.** Be Vietnam Pro (UI) and Playfair Display (titles), OFL, self-hosted with `next/font/local`; no runtime font CDN.
5. **Private art.** The repository is public, so character art is never committed, attached or uploaded. The web app reads it at run time from the directory in `MASCOT_ART_DIR` and serves it only to signed-in users through a route handler with an allowlist of file names. With no directory it uses a fallback theme (gradient, original SVG motif, initials) and tests pass without the art. Committed icons and empty-state art are original and show no character. The character's name never appears in the UI, locale files, alt text or public docs; the credits screen carries the licence attribution.
6. **Expressions.** Three sets share seven keys (`greet`, `joy`, `love`, `surprise`, `ask`, `sulk`, `sleep`). The user picks the set (chibi by default) and the key shown per state; settings `appearance.expression_set` and `appearance.expression_map`.
7. **Navigation.** Pill nav on desktop, bottom bar with a "More" sheet on phones, a companion panel on the right of every screen except the dashboard and the focus session. Admin items are hidden for non-admins.
8. **Read-route shapes stay local for now.** The new read routes (notify inbox, rules faults, ai keys list) keep zod schemas local to `apps/web` (`lib/api-shapes/`), validated at the edge, because the server sides are still being built in this milestone. A shared fixture file used by both the web and the producing service tests limits drift. A follow-up ADR moves the shapes into contracts once the routes are stable; it is tracked as an issue.
9. **Gateway wiring.** The gateway gets per-prefix routes and upstream variables for `ai`, `notify`, `ingest` and `monitor`, one test per prefix. A route no service serves yet is built in the owning service first.
10. **Dependencies.** A new runtime dependency needs a line stating its size and memory cost in the plan or its ADR.

## Consequences

- The web container keeps its 256 MB limit and 192 MB heap cap; features give way before the limit is raised, and raising it needs an ADR.
- Pages already render dynamically, so the cookies add no new cost.
- Local shapes duplicate knowledge until the follow-up ADR; the shared fixture limits the risk.
- A later visual change touches tokens, not components.
- Anyone cloning the repository sees the fallback theme; the owner's machine sees the character art.
