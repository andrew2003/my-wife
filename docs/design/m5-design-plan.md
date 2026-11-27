# M5 design plan: visual system, navigation, theming, locale

Status: draft for review (2026-11-28). Owner brief: M5 in `factory/prompts/milestones.md`. Decisions: ADR 0014. Source of truth for conflicts: `docs/spec/00-final-decisions.md`. No application code is part of this plan.

## 1. Principles

- The app is a caring assistant ("wife"), mascot Whale-chan: cute, elegant, never sexualized. No DeepSeek name or logo in UI or assets.
- Calm, single-column, generous whitespace, pill buttons, large-radius cards, soft shadows, translucent sticky top bar.
- Both themes and both languages are designed, not inverted.
- All UI strings come from `apps/web/locales/{vi,en}.json` (CLAUDE.md language policy).

## 2. Design tokens

All tokens are CSS custom properties on `:root` (light) and overridden under `[data-theme="dark"]` and `@media (prefers-color-scheme: dark)` for `:root:not([data-theme])`.

| Group | Tokens |
|---|---|
| Color | `--c-bg`, `--c-surface`, `--c-surface-2`, `--c-text`, `--c-muted`, `--c-primary`, `--c-on-primary`, `--c-link`, `--c-gold`, `--c-gold-text`, `--c-danger`, `--c-success`, `--c-warning`, `--c-border`, `--c-focus` |
| Radius | `--r-sm 10px`, `--r-md 14px`, `--r-lg 20px`, `--r-xl 24px`, `--r-pill 999px` |
| Space | 4-based scale `--s-1 4px` to `--s-8 64px` |
| Shadow | `--sh-1` (card), `--sh-2` (sheet, dialog); navy tint in light, black 40% in dark |
| Motion | `--t-fast 150ms`, `--t-base 220ms`, easing `cubic-bezier(.2,.7,.2,1)`; all set to `0ms` under `prefers-reduced-motion: reduce` |
| Layout | `--w-content 720px`, `--w-wide 1080px`, `--nav-w 240px`, `--nav-w-collapsed 72px`, `--topbar-h 56px`, `--tap 44px` |
| Type | `--font-ui`, sizes `--fs-sm 14`, `--fs-md 16`, `--fs-lg 18`, `--fs-xl 24`, `--fs-2xl 32`; line height 1.5 body, 1.25 titles |

Breakpoints: 360 (min supported), 640 (side nav appears collapsed), 1024 (side nav expanded), 1440+ (content stays centered at `--w-wide`).

### Palettes (derived from the character poster)

Brand anchors: navy `#1B2559`, royal blue `#2F5BB7`, gold `#C9A45C`, ocean light from the hair, cream apron.

| Token | Light | Dark |
|---|---|---|
| `--c-bg` | `#F6F9FD` (cream to ice-blue gradient on the body) | `#0A1230` (deep ocean gradient) |
| `--c-surface` | `#FFFFFF` | `#121B45` |
| `--c-text` | `#141E4A` | `#EDF2FF` |
| `--c-muted` | `#46517A` | `#AAB7DE` |
| `--c-primary` | `#2F5BB7` | `#8DB0FA` |
| `--c-on-primary` | `#FFFFFF` | `#0A1230` |
| `--c-link` | `#244A9A` | `#9DBBFB` |
| `--c-gold` (decorative) | `#C9A45C` | `#E2C374` |
| `--c-gold-text` | `#6F5210` | `#E2C374` |
| `--c-danger` | `#B42318` | `#FF9C94` |
| `--c-success` | `#1B7042` | `#78D9A3` |
| `--c-warning` | `#8A5300` | `#F4CB69` |
| `--c-border` (controls) | `#7C89B0` | `#6F7FB8` |
| `--c-focus` | `#2F5BB7` | `#8DB0FA` |

### Computed contrast (WCAG 2.x relative luminance; text needs 4.5, large text and UI parts 3.0)

| Pair | Light | Dark | Needs |
|---|---|---|---|
| text on bg | 15.13 | 16.41 | 4.5 |
| text on surface | 15.98 | 14.78 | 4.5 |
| muted on bg | 7.32 | 9.23 | 4.5 |
| muted on surface | 7.73 | 8.31 | 4.5 |
| on-primary on primary (button) | 6.36 | 8.51 | 4.5 |
| primary on bg (link, icon) | 6.02 | 8.51 | 3.0 / 4.5 |
| primary on surface | 6.36 | 7.67 | 4.5 |
| link on surface | 8.33 | 8.62 | 4.5 |
| gold-text on surface | 7.27 | 9.69 | 4.5 |
| gold on surface | 2.35 | 9.69 | decorative only on light |
| danger on surface | 6.57 | 8.23 | 4.5 |
| success on surface | 6.10 | 9.66 | 4.5 |
| warning on surface | 6.33 | 10.72 | 4.5 |
| border on surface | 3.46 | 4.26 | 3.0 |
| focus ring on bg | 6.02 | 8.51 | 3.0 |

Rule: `--c-gold` is never used for text or a control boundary in light mode (2.35 fails); use `--c-gold-text`. The table is reproduced by a unit test in `apps/web` (`contrast.test.ts`) that reads the token table (one TypeScript source, generated into the CSS file at build or checked against it) and fails under 4.5 or 3.0 per pair above. Cards over the background art are opaque (`--c-surface`) or at least 92% opaque; the test also measures text on the worst-case blend of art at its maximum opacity.

## 3. Typography

- UI font: Be Vietnam Pro (SIL OFL 1.1), full Vietnamese coverage. Two weights only: 400 and 600. Titles use 600; no display serif in v1 (optional in the brief; saves a file and memory). Revisit only if the owner asks.
- Files: `apps/web/fonts/be-vietnam-pro-{400,600}.woff2`, subset to Latin plus Vietnamese (U+0000-00FF, U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+1EA0-1EF9, punctuation and currency `U+20AB`). The OFL text is committed beside them (`apps/web/fonts/OFL.txt`) with the source URL and version.
- Loaded with `next/font/local` (`display: swap`, `preload` on, variable `--font-ui`). No runtime request to any font CDN; a test greps the build output for `fonts.googleapis`.
- Numbers use tabular figures (`font-variant-numeric: tabular-nums`) for money and countdown.

## 4. Navigation information architecture

Five areas (labels from locale keys `nav.*`):

| Area | Items |
|---|---|
| Today | Dashboard `/`, Today `/schedule/today`, Focus/countdown, Inbox `/inbox` |
| Schedule | `/schedule`, Review `/schedule/review`, Calendar |
| Budget | Overview `/budget`, Funding `/budget/funding`, Anomalies `/anomalies`, Contract `/contract` |
| Routines | `/routines`, `/routines/sleep`, Faults `/faults` |
| More | Settings, Models `/settings/models`, Privacy `/settings/privacy`, Admin (admin only), Language and theme |

There are 19 current routes; the table is the target mapping and the first M5 issue lists each route under exactly one area (a test fails when a route has no area).

- Desktop (>=640): sticky translucent top bar (logo, greeting, `VI | EN` control, theme control, account menu) with `backdrop-filter` only on the bar itself (small area). Side nav with icons, collapsible (collapsed state in `mw_nav` cookie, same attributes as the theme cookie), active item marked by pill background plus `aria-current="page"`.
- Phone (<640): bottom tab bar with four items (Today, Schedule, Budget, Routines) plus "More" which opens a sheet listing the remaining items, language and theme. The sheet is a `role="dialog"` with `aria-modal`, focus trap, Escape and backdrop close, focus returned to the opener, safe-area padding. Active tab marked as above.
- Admin items are not rendered for non-admins (server-side role check; the API still enforces).
- Home page becomes a dashboard: assistant greeting, today's checklist and next task, countdown, running-cycle budget summary, routine status, recent messages. Each card has a skeleton, an empty state and an error state with retry.

## 5. Component list

Button (primary, secondary, ghost, danger; pill), IconButton, Input, Select, Textarea, Toggle (switch), Checkbox, SegmentedControl (used by language and theme), Card, StatTile, Tabs, Badge/Chip, ProgressBar, Table that collapses to stacked cards under 640, Dialog, Sheet, Toast (region with `aria-live`), Skeleton, EmptyState and ErrorState (mascot mood: `calm`, `thinking`, `oops`, with retry), TopBar, SideNav, BottomBar, MoreSheet, PageHeader (centered heading), Avatar/AccountMenu, BackgroundArt. Every control: minimum 44 px target, visible focus ring (`--c-focus`, 2 px plus 2 px offset), keyboard operable, name from locale keys. Mascot moods are small SVG or WebP assets (<=20 KB each), produced under the same provenance rules as section 7.

## 6. Theming mechanism

- Cookie `mw_theme` in `light | dark | system` (missing means `system`). Attributes: not HttpOnly (the client control writes it), `SameSite=Lax`, `Path=/`, `Max-Age` one year, no `Secure` requirement in dev, `Secure` when served over HTTPS.
- Root layout reads `cookies()` per request and renders `<html lang data-theme>`: `light` or `dark` set the attribute; `system` sets none and the CSS `@media (prefers-color-scheme: dark)` block applies. Because the first paint comes from server HTML plus CSS, there is no flash and no inline script. `<meta name="color-scheme" content="light dark">` and `viewport.themeColor` for both schemes (media-specific entries).
- The theme control is a three-state SegmentedControl; it sets the cookie in the client and updates `data-theme` immediately (no navigation). Server action alternative rejected: needs a round trip.
- `force-dynamic` is already in the layout, so the layout is not the freeze. The real freezes are the layout module-level `metadata` (replace with `generateMetadata` using the request locale), `app/manifest.ts` and `app/page.tsx`, which call `defaultLocale(process.env.UI_LANGUAGE)`.
- Charts and dialogs read the same tokens; no hard-coded color outside the token file (lint rule: a stylelint or grep test fails on hex colors outside `tokens.css`).

## 7. Locale fix design

- A single helper `getRequestLocale()` (cookie `mw_locale`, else `Accept-Language`, else `defaultLocale(UI_LANGUAGE)`) is used by layout, every page, `generateMetadata` and the client provider. Client components receive the locale from the provider and never read `process.env`. `UI_LANGUAGE` may be read in exactly one file; a test greps `apps/web` for other uses.
- `manifest.ts` cannot see a cookie reliably (it is fetched by the browser without a user context decision), so it uses the default locale (`UI_LANGUAGE`) for `name`, `short_name`, `description`; `theme_color` and `background_color` come from the light tokens; icons: 192, 512 and a maskable 512 (navy background, mascot inside the safe zone), generated once and committed.
- `/locale?lang=xx&next=/path` (route handler): `lang` must be `vi` or `en`, otherwise 400. The cookie is set, then 303 to the target. Target resolution: `next` if valid, else the `Referer` path if same-origin and valid, else `/`. A path is valid only when: it starts with a single `/`; it does not start with `//` or `/\`; it contains no `\`, no control characters, no scheme and no `@` in the first segment; after decoding (up to two passes) it still passes all checks (so `%2F%2Fhost`, `%5Chost`, `/%09/host` are rejected); length <= 512. The redirect `Location` is always the relative path, never an absolute URL built from the Host header. Table-driven test cases (each must resolve to `/` or the safe fallback): `//evil.com`, `/\evil.com`, `https://evil.com`, `javascript:alert(1)`, `%2F%2Fevil.com`, `/%2Fevil.com`, `/%5Cevil.com`, `///evil.com`, `/\t/evil.com`, `evil.com`, empty, 600-char path; valid: `/budget`, `/schedule/today?day=2026-11-28`, `/settings/models#keys`.
- The segmented `VI | EN` control shows both languages with the active one highlighted and `aria-pressed`; its group name is in the current locale (`locale.switch.label`). Switching sets the cookie only (no profile write) by default; persisting to the user profile is out of scope and listed as an owner question.
- Tests: a catalog parity test (same keys in `vi` and `en`, same placeholders); a test that no `en` value contains Vietnamese diacritics (an allowlist file `locales/identical-allowlist.json` names strings that may be identical across languages, such as "OK" or proper nouns); a grep test that no `.tsx` has a Vietnamese literal; the e2e (section 9) asserts `html[lang]` and the absence of catalog strings of the other language, honoring the allowlist.

## 8. Background art

One-off, manual, local. The cut-out is produced once by a person or agent on a developer machine and the result is committed; the tool is not a repository dependency and is not run in CI.

1. Source: `docs/image/deepseek_maid.jpg` (committed by the first PR that needs it; the owner provided it for this public repository). The original keeps its place; the filename contains the vendor name, so a copy is renamed to `whale-chan-source.jpg` in `docs/image/` in the same PR (git rename of the original is allowed because the owner file is new in git), and the UI never uses the word "deepseek". Check that the image has no visible watermark or logo; if one exists, crop or paint it out in the cut-out, and record that in provenance.
2. Cut-out tool: a local background-remover (for example `rembg` with the `isnet-anime` model, or GIMP and manual masks). The ADR for the actual PR records the exact tool name and version, the model and the commands in `docs/design/art-provenance.md`. Remove poster background, text, swatches.
3. Export: `apps/web/public/art/whale-chan.webp` (and `.png` fallback), two sizes (about 1200 px and 600 px tall for phones), alpha preserved, metadata (EXIF, XMP, ICC extras) stripped (`exiftool -all=`), each file at most 150 KB (a test fails over the limit). Mascot mood illustrations follow the same rules.
4. Use: `next.config` sets `images.unoptimized = true`; the art is a CSS `background-image` or plain `<img>` in one `BackgroundArt` component: `position: fixed; inset: 0; pointer-events: none; z-index: -1; aria-hidden="true"`; `image-set()` with the PNG fallback. No blur or filter on a full-viewport layer (GPU and memory cost). Dark mode uses a pre-tinted second asset (`whale-chan-dark.webp`, blue tint baked in, faint glow baked in) instead of a runtime filter; opacity about 0.12 light and 0.18 dark, tuned so the contrast test (section 2) passes with the art at maximum opacity.
5. Placement: anchored bottom-right on desktop (height about 85 vh), smaller and fainter on phones (opacity 0.08, cropped to the lower right). No animation; a gentle fade-in only, disabled under `prefers-reduced-motion`.
6. Provenance doc: `docs/design/art-provenance.md` lists each shipped asset, its source, tool and version, date, size.

## 9. CSS approach and memory cost

Plain CSS variables plus CSS Modules. Rejected: Tailwind (build-time memory and a new toolchain on a 16 GB machine), CSS-in-JS (runtime cost, hydration cost), animation libraries (bundle size). Costs and limits:

- Added JS: none beyond the small client controls (theme, language, sheet, nav collapse), all hand-written. Estimated first-load JS increase under 15 KB gzip.
- CSS: one global token file (about 4 KB) plus modules; estimated under 40 KB total.
- Images pre-generated at build-free time (committed), so no `sharp` image optimization at runtime (`images.unoptimized`), which avoids the optimizer's memory spike.
- Fonts: two weights, subset, about 60 KB total.
- `backdrop-filter` only on the top bar and the bottom bar (small areas), never on the page.
- The web container keeps its 256 MB limit and a 192 MB heap cap (`NODE_OPTIONS=--max-old-space-size=192` in its Dockerfile `CMD`); measured idle and under the e2e run RSS is recorded in the handoff. If the measurement exceeds the limit, the owner decides (see questions).
- Builders run `pnpm --filter @my-wife/web test|typecheck|lint` only.

## 10. End-to-end plan

- A serial tail: the all-screens test, the locale test and the screenshot run share one fixture and run after builders finish. Playwright: Chromium only, headless, `workers: 1`, against `next build` plus `next start`, CPU delegate. One run at a time, started by `qa` or the lead.
- All-screens test: sign in through `/demo-login`, visit every route in the navigation table, fail on any 4xx/5xx API response, any `role="alert"` error, any console error, and any horizontal scroll at 360 px.
- Locale test: switch to English, visit every navigation screen, assert `html[lang="en"]` and no Vietnamese catalog string in visible text; repeat for Vietnamese (with the allowlist).
- Screenshot matrix: dashboard, budget, schedule today, routines, inbox, settings; phone (360x780) and desktop (1440x900); light and dark; vi and en: 6 x 2 x 2 x 2 = 48 PNGs, written to `factory/handoff/M5-screens/<screen>-<viewport>-<theme>-<lang>.png`, never committed (`factory` is outside git).
- Unit tests: contrast, locale redirect table, catalog parity, art size limit, token usage.

## 11. Audit responses

| # | Finding | Response |
|---|---|---|
| 1 | Gateway 404s are mixed in cause | Accepted. The first backend issue is "demo persistence and API probe": a script logs in via `/demo-login`, calls every API path the web uses and records status per path into the issue; each 404 is classified as (a) missing gateway upstream (`ai`, `notify`, `ingest`, `monitor`), (b) missing service route (rules `GET /faults`, notify `GET /inbox`), (c) missing demo data or in-memory state lost. Gateway gets per-prefix tests; new env (`NOTIFY_URL`, `AI_URL`, `INGEST_URL`, `MONITOR_URL`) is recorded in `docs/decisions.md`. Fix order: persistence and probe, upstreams, service routes, web. |
| 2 | New read routes lack contract schemas | ADR 0014 point 6: local zod in web with a shared fixture; follow-up ADR moves them to contracts. Contracts untouched here. |
| 3 | Where the freeze really is | Section 6: layout `metadata` becomes `generateMetadata`; `manifest.ts` uses the default locale by design; `page.tsx` takes the request locale. `force-dynamic` stays. |
| 4 | Theme cookie attributes | Section 6: not HttpOnly (client writes), `SameSite=Lax`, one year; `system` by CSS media query. |
| 5 | `/locale` open redirect | Section 7: single-slash relative paths only, decoded checks, `Referer` fallback, cookie-only switch, table-driven test. |
| 6 | Catalog drift and mixed languages | Section 7: parity, no Vietnamese in `en`, no inline Vietnamese in tsx, e2e with an allowlist for identical strings. |
| 7 | Memory | Section 9. |
| 8 | Asset naming, provenance, metadata, watermark | Section 8 steps 1, 3, 6. |
| 9 | Cut-out tool as dependency | Section 8: one-off manual, not a dependency, not in CI. |
| 10 | Contrast with art, gold on light | Section 2: pure-function test, opaque cards, gold decorative on light only. |
| 11 | e2e resource use | Section 10: serial, one worker. |
| 12 | Demo persistence and M4 gaps | First backend issue (see 1) also verifies each of the four M4 gaps (rules `incident.*`, runner `cycle.opened` and `fault.detected`, demo persistence, #273) with a reproducing test before fixing. |
| 13 | 19 nav items, admin, More sheet | Section 4. |
| 14 | Manifest colors and icons | Section 7. |
| 15 | Fonts local | Section 3. |
| 16 | Gate before backlog | ADR 0014 point 8; the questions below must be answered first. |

## 12. Questions for the owner (block the backlog)

1. Is a cookie-only language switch acceptable, or should it also save to the user profile?
2. Display serif for page titles: skip in v1 (this plan) or add one (about 30 KB more)?
3. Should the mascot mood set be limited to three moods (`calm`, `thinking`, `oops`) for v1?
4. If the web container exceeds 256 MB under the e2e run, raise its limit or cut features?
5. Confirm renaming the committed copy of the poster away from the `deepseek` filename.
