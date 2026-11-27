# M5 design plan: design system, skins, screens, sheets, commands

Status: revised 2026-11-28 to match the final owner brief. Decisions: ADR 0014 (design system, theming, locale, read routes), ADR 0015 (two-way sync and calendars), ADR 0016 (chat command contracts). Source of truth for conflicts: `docs/spec/00-final-decisions.md`. This document plans work; it contains no application code.

The visual reference is a set of static mock-up frames kept on the owner's machine outside the repository. Components are rebuilt in Next.js with locale files; no text or image from the mock-up is copied into the repository.

## 1. Principles

- The app is a caring assistant who speaks as the user's wife. The character is a mascot only. Its name never appears in the UI, locale files, alt text, code or public docs; the product name is "My Wife".
- Soft and calm: sticky translucent top bar with blur and a thin border, pill buttons and chips, cards with 22 to 28 px radius, soft shadows, generous whitespace, short motion.
- Every screen is designed for light and dark, in four skins, in Vietnamese and English.
- One global appearance setting (skin and mode) drives every screen through shared tokens on the root, never per screen.
- All UI strings come from `apps/web/locales/{vi,en}.json`.
- Principle 4 holds everywhere: the model writes words, code decides numbers.

## 2. Locale bugs (first issue, tests first)

Reproduced on `main`: after choosing English, navigation is English and the page body stays Vietnamese.

Causes: `app/page.tsx`, `app/manifest.ts` and the root `metadata` call `defaultLocale(process.env.UI_LANGUAGE)`; `app/locale/route.ts` always redirects to `/`; `components/locale-switch.tsx` shows the target language, which reads as the current state.

Design:

- One helper `getRequestLocale()` (cookie `mw_locale`, else `Accept-Language`, else `defaultLocale(UI_LANGUAGE)`) used by the layout, every page, `generateMetadata` and the client provider. Client components receive the locale from the provider. `UI_LANGUAGE` is read in exactly one file as the fallback; a test greps `apps/web` for other reads.
- Root `metadata` becomes `generateMetadata`. `manifest.ts` cannot see user context, so it uses the default locale for its text; this is the one deliberate exception and is recorded in `docs/decisions.md`.
- `/locale?lang=xx&next=/path`: `lang` must be `vi` or `en`, otherwise 400. The cookie is set, then 303 to a relative path. Target: `next` if valid, else the same-origin `Referer` path if valid, else `/`. A path is valid only when it starts with a single `/`, does not start with `//` or `/\`, has no `\`, control characters, scheme, or `@` in the first segment, still passes after up to two decoding passes, and is at most 512 characters. The `Location` is always the relative path.
- Table-driven cases that must resolve to the fallback: `//evil.com`, `/\evil.com`, `https://evil.com`, `javascript:alert(1)`, `%2F%2Fevil.com`, `/%2Fevil.com`, `/%5Cevil.com`, `///evil.com`, `/\t/evil.com`, `evil.com`, empty, a 600-character path, and a cross-origin `Referer`. Valid: `/budget`, `/schedule/today?day=2026-11-28`, `/settings/models#keys`.
- The segmented `VI | EN` control shows both languages, the active one highlighted, `aria-pressed`, group name from the current locale. It sets only the cookie.
- Tests: catalog parity (same keys and placeholders), no Vietnamese diacritics in `en` values (an allowlist file names strings that may match across languages), no Vietnamese literal in `.tsx`. The end-to-end test signs in, switches to English, visits every screen and asserts `html[lang="en"]` and no `vi` catalog string in visible text; then the same for Vietnamese.

## 3. Private art

- The repository is public. Source images, cut-outs, faces, stickers and logos that show the character are never committed, never attached to an issue or PR, never uploaded, and never added and removed in history. Sources live in `docs/image/`, derived files in `.private-assets/`; both are ignored by rules in `.gitignore` (added in the same PR as this plan). Those rules on `main` are a prerequisite of every issue that touches art.
- Run-time loading: the web app reads art from the directory named by `MASCOT_ART_DIR`. A route handler serves files from it only to signed-in users, with path validation (file names from an allowlist built from the directory listing, no traversal), cache headers and pre-sized variants. It is never a public static path.
- Fallback theme when the directory is missing (CI, fresh clone): gradient background, an original wave or whale-tail motif in SVG, initials for avatars, and original neutral empty-state art. Tests and CI pass without the art. One test starts the app with the variable unset and asserts the fallback renders and every screen still works.
- Anything committed (favicon, repository PWA icons, empty-state art) is original non-character artwork. Character versions of the logo and PWA icons are served from the private directory at run time.
- The approved files are used exactly as provided. Nothing is redrawn, restyled or given drawn-on effects.
- The credit text (original character author, derivative author, CC BY-NC-SA 4.0, private non-commercial use) lives in a credits file inside the private art directory, and the in-app credits screen renders it from there. Public docs and locale files say only that credits are loaded from the private art directory; with no directory the screen shows a generic note. No third-party AI brand name or logo is used.
- Size variants (for example small, medium and large per image) are pre-generated by a local script into the private directory; nothing is resized at run time and no image library is added. If the directory holds only originals, the app serves the original; the fallback test also covers a directory without variants.
- Art file keys follow the board names (for example `dress-full`, `hanfu-full`, `silver-full`, `street-full` with a `-dark` variant, expression keys of section 6, `logo-512`, `logo-192`, `logo-maskable-512`, `logo-white-512`). The component asks for a key, size and mode; the server maps it to a file.

## 4. Design tokens, skins and modes

Tokens are CSS custom properties with the `--mw-` prefix, defined in one TypeScript source that generates the stylesheet (so a unit test can read the same table). Groups: color, radius (22 to 28 px for cards, pill for controls), space (4-based), shadow, motion, layout, type.

Brand colors: navy `#16204A`, royal `#2F5BB7`, ocean `#6FB6E8`, gold `#C9A45C`, white `#FFFFFF`, black `#0B0B10`. Status colors and the full light and dark tables are taken from the approved board. Primary per skin (light / dark): `navy` `#16204A` / `#6FB6E8`, `hanfu` `#27407F` / `#9CC3F0`, `silver` `#3443B8` / `#A3ADFF`, `street` `#0B0B10` / `#FFFFFF` with accent `#2F54EB`.

Mechanism:

- Settings `appearance.skin` (`navy` default, `hanfu`, `silver`, `street`) and `appearance.mode` (`light`, `dark`, `system`). Stored in cookies `mw_skin` and `mw_mode` (not HttpOnly because the client control writes them; `SameSite=Lax`, `Path=/`, one year; `Secure` over HTTPS) and mirrored to the user profile once signed in.
- The root layout reads the cookies per request and renders `<html lang data-skin data-mode>`. `system` sets no `data-mode` and CSS `prefers-color-scheme` applies. Server HTML plus CSS means no flash and no inline script. `viewport.themeColor` has a light and a dark entry.
- Selectors `[data-skin="x"]` and `[data-skin="x"][data-mode="dark"]` override the primary, accent and surface tokens. The art component picks the skin file and its `-dark` variant from the same two attributes. In `system` mode the server does not know the resolved mode, so art is rendered as a `picture` element with `prefers-color-scheme` media sources (light default, dark source); this avoids a dark-art flash without a script or an extra cookie.
- Dark is designed per skin, not inverted. A pure unit test reproduces WCAG 2.x contrast for every text, control and focus pair in all 4 skins x 2 modes (4.5 for text, 3.0 for large text, control boundaries and focus rings) and fails below the threshold. Gold is decorative only where it fails contrast; a test greps modules for the gold token outside an allowlist. A test fails on a hex color outside the token source.
- Responsive from 360 px up with no horizontal page scroll; touch targets at least 44 px; visible focus ring; motion limited to transform and opacity and removed under `prefers-reduced-motion`.

Typography: Be Vietnam Pro (UI) and Playfair Display (titles), both OFL, self-hosted through `next/font/local` with Latin plus Vietnamese subsets and `display: swap`. No runtime font CDN; a test greps the build output for font CDN hosts. Weights: UI 400 and 600, titles one serif weight, plus an italic only if the board uses it. Tabular figures for money and countdown. Licence texts sit beside the font files.

Logo and PWA icons: the wordmark is "My Wife" alone. The manifest's text uses the default locale; its icons point to original committed icons, and signed-in clients get the character icons from the private directory.

## 5. Expressions

- Keys, identical across three sets: `greet`, `joy`, `love`, `surprise`, `ask`, `sulk`, `sleep`.
- Sets: chibi (default for the whole system and every skin), blue-hair faces, silver-hair faces. The file map per key is a server-side table that reads the private directory; with no directory, initials or neutral SVG stand in.
- Small images (message avatars, reactions, empty and error states) use the active set. Faces are rounded squares, chibis uncropped.
- State to key mapping: greeting, task done, praised, news, needs an answer, fault or penalty, bedtime. Defaults come from the board; the user changes the set and, per state, the key in settings. Because keys are shared, switching sets keeps the mapping. Stored as `appearance.expression_set` and `appearance.expression_map`.
- Extra images found in the private directory can be offered as additional choices later. Mood tag commands (section 10) can pick an expression key.
- No drawn-on effects are added to any image.

## 6. Screens and navigation

Every route is placed in one of the areas below or excluded in one source file; a test enumerates `app/**/page.tsx` and fails when a route is in neither.

| Area | Routes |
|---|---|
| Today | `/` dashboard, `/schedule/today`, `/monitor` (focus session), `/inbox` (label "Messages") |
| Schedule | `/schedule`, `/schedule/review`, `/schedule/calendar`, timetable sheet |
| Budget | `/budget`, `/budget/funding`, `/anomalies`, `/contract`, `/penalties`, `/debts`, `/cycle-close`, `/receipts/[id]` (detail), budget sheet |
| Routines | `/routines`, `/routines/sleep`, `/faults` |
| More | `/settings`, `/settings/models`, `/settings/privacy`, `/settings/appearance`, `/settings/persona`, `/settings/commands`, credits, `/admin` (admin only) |

`/onboarding` is excluded from navigation (first-run redirect). Admin items are not rendered for non-admins; the API still enforces the role.

Shell: a sticky translucent top bar and a pill nav on desktop; a bottom tab bar with a "More" sheet on phones (a dialog with focus trap, Escape, backdrop close, focus return, safe-area padding). Every screen except the dashboard and the focus session has a companion panel on the right with an LLM-written remark for that screen (section 7).

Screens, following the board:

- **Dashboard.** Three columns on desktop (cards, character, cards), a centred hero on phones. The character is fully opaque and animated with transform and opacity only (float, sway, breathing, pulsing halo, ground shadow, rising bubbles, a hop when a task is ticked). Speech bubble with typing dots, then the text from section 7, and a reaction sticker. Checklist rows are large rounded buttons with a round check, title, time and a status chip (done, upcoming, not done); ticking plays a check pop and a sparkle burst, strikes the title and advances the bar; a late task wobbles gently. Every state change gets a reaction announced with `role="status"`. A messages card shows her messages with a matching sticker and quick-reply chips.
- **Schedule.** Tabs today, week, solar and lunar calendar, weekly review; week strip; timeline with done, late, current and upcoming blocks; a details button on every block (time, repeat, monitoring, sync status per calendar, edit, open in calendar); running-block card with countdown; fault points; calendar sync chips; a button that opens the timetable sheet.
- **Focus session.** Opened from the start-session button: Pomodoro progress, distraction and fault counts, a countdown ring on the server clock, pause, finish early, leave with a reason, always-on-top window, end sound, full screen, the on-device camera panel with presence status and the privacy note (video stays on the device, nothing is stored), and the urgent prompt for a reason with its answer deadline.
- **Budget.** Cycle, week and penalty summary; categories with need or want tag, transfer code and progress; transactions, with an unknown spend asking for a category; a button that opens the budget sheet. The words "top up" are not used anywhere (UI, locale files, docs). Money is never paid into the app: funding a cycle is the user moving their own money between their own bank accounts using the transfer list with prefilled QR codes; the app only reads the receipt. Locale wording: "transfer list" and "verified by receipt". The Vietnamese keys `funding.title` ("Nạp tiền …"), `funding.empty` and `funding.status.funded` ("Đã nạp đủ") and their English counterparts are reworded in the screens issue. A test greps both catalogs against banned-wording lists (English: "top up", "top-up"; Vietnamese: the verb for paying money in and its past form, kept in the test fixture).
- **Routines.** Wake photo banner, one card per routine with the four-level control, a note and a week strip.
- **Messages.** Filters, chat thread with a sticker on each of her messages, inline answer chips, sticker button, input, send, command autocomplete.
- **Settings.** Appearance (skin, mode), address terms, expression mapping, chat commands and the existing sections.
- Loading uses skeletons. Empty and error states are friendly, with a sticker or fallback art and a retry action.

Component list: Button, IconButton, Input, Select, Textarea, Toggle, Checkbox, SegmentedControl, Card, StatTile, Tabs, Chip, ProgressBar, ResponsiveTable, Dialog, Sheet, Toast, Skeleton, EmptyState, ErrorState, TopBar, PillNav, BottomBar, MoreSheet, PageHeader, Avatar, AccountMenu, CompanionPanel, SpeechBubble, Mascot (art key, size, mode, fallback), SheetGrid (editable, computed and locked cells), CommandEditor.

## 7. Voice and address terms

Three user-editable lists per locale (add, edit, remove, switch on or off, custom text). The directions are never mixed.

| Setting | Meaning | vi defaults (also offered) | en defaults (also offered) |
|---|---|---|---|
| `persona.address_user` | how she addresses the user | "anh yêu", "chồng yêu", "anh ơi" ("ông xã", "mình ơi") | "honey", "darling", "my love" ("hubby", "sweetheart") |
| `persona.self_reference` | how she refers to herself | "em" ("vợ") | "I" |
| `persona.wife_label` | how the user addresses her, used in UI labels | "vợ yêu" ("em yêu", "em ơi", "bà xã") | "my wife" ("wifey", "honey", "my love") |

- Conversation text is written by the model from structured facts supplied by code (task, time, amounts, fault points, penalty, state) plus persona context: chosen terms, strictness, locale, time of day, recent conversation and a few reference examples for tone. Examples are context only and are never replayed verbatim; replies vary; in chat the model answers freely. Higher strictness uses fewer sweet words.
- The number check is code: after generation, every number, time and amount in the text must match the supplied facts. On a mismatch, a timeout or degraded mode, a short fixed fallback sentence from the locale files is sent. The model never computes or decides money, fault points or penalties. The remark shown on each screen is generated at most once per user, screen and day (setting `ai.companion_remark_cache_hours`) and cached; if generation fails, times out or fails the number check, the fixed fallback sentence is shown and cached for that period.
- Fixed text is UI text only and lives in locale files with placeholders such as `{addressUser}`, `{self}`, `{wifeLabel}`; it follows the user's settings.
- Tests: both locales, a custom term, a removed default, the number check with a wrong amount, the fallback path.
- The new settings keys are added to `docs/spec/02-defaults.md` with the same change that implements them.

## 8. In-app sheets and sync (see ADR 0015)

- Two sheet views: the timetable sheet (timetable, routines, fault points, weekly review) and the budget sheet (budget categories, bank accounts, weekly plan, transaction ledger, surplus and goals). A week switcher offers last week, this week, next week and history. White cells are editable in place and change the real data through the owning service; grey cells are computed by code and locked; past weeks are read-only. The view shows sync status and a link to the Google Sheet.
- Two-way Google Sheets sync, calendars as two equal options (Google, Apple through CalDAV), details and rules in ADR 0015 and `docs/spec/41-sync.md`. The spec change comes first; `packages/contracts` changes only through the ADR.

## 9. Chat commands (see ADR 0016)

A message starting with `/` from the linked user, in Telegram, Discord or the in-app chat (with autocomplete). Parsed and executed by code; only commands marked AI pass text to the model. Text inside forwarded emails, receipts or sheet cells is never a command.

- Control: `/help`, `/model [name]`, `/usage`, `/status`, `/new`, `/stop`, `/lang vi|en`, `/strict 1-5`, `/quiet [until HH:MM|off]`, `/skin [name]`. Capture: `/task`, `/spend`, `/remember`, `/forget`. Summaries (AI, facts from code): `/summary`, `/today`, `/week`, `/budget`. Mood tags: `/happy`, `/sad`, `/tired`, `/stressed`, `/angry` plus a message; the mood is stored with it and never changes money, fault points or penalties. Rules: `/appeal [fault]`, `/reason <text>`.
- Each command has an English name and a Vietnamese alias and an editable description (one or two sentences) that goes into the model context when the command is used, into `/help` and into the Telegram and Discord command menus. Built-ins ship default descriptions in both locales and can be reset. A description is user context and never a way around code rules.
- Customisation: switch on or off, rename, aliases, description; custom commands of three kinds (prompt template with `{text}`, mood tag with an expression, shortcut with preset arguments), with try and delete. Names are lowercase letters, digits and underscores, at most 32 characters, unique per user. The enabled list is registered with Telegram and Discord.
- Tests: parsing, aliases, a disabled command, a custom prompt command, a mood tag, descriptions reaching the model context, the untrusted-text rule, both locales.

## 10. Gateway wiring and demo data

After `/demo-login` the gateway returns 404 for `/api/budget/overview`, `/api/budget/funding`, `/api/weeks/current`, `/api/notify/inbox`, `/api/faults` and `/api/keys`. Each path is reproduced first by a probe script that logs in and records the status per path, then classified and fixed in this order: persistence of demo state, gateway upstreams, service routes, web.

| Path | Upstream | Hypothesis to verify |
|---|---|---|
| `/api/budget/overview` | budget | demo seed or a missing route |
| `/api/budget/funding` | budget | demo seed or a missing route |
| `/api/weeks/current` | schedule | demo seed or the gateway prefix `/weeks` |
| `/api/notify/inbox` | notify | gateway upstream and service route `GET /inbox` |
| `/api/faults` | rules | gateway prefix and service route `GET /faults` |
| `/api/keys` | ai | gateway upstream (falls through to identity) |

- The gateway gets per-prefix routes and upstream variables for `ai`, `notify`, `ingest` and `monitor`, one test per prefix; the variables are recorded in `docs/decisions.md`. A route no service serves yet is built in the owning service first; the gateway never answers it.
- Known gaps fixed with a reproducing test first: `rules` consuming `incident.*`, the dev runner forwarding `cycle.opened` and `fault.detected`, demo state persistence, issue #273.
- All-screens end-to-end test: sign in through `/demo-login`, visit every route in section 6 (with fixture ids for `/receipts/[id]` and `/onboarding`), fail on any 4xx or 5xx API response, any `role="alert"` error, any console error and any horizontal scroll at 360 px.
- Serial tail, one run at a time: Chromium only, headless, `workers: 1`, against `next build` plus `next start`, CPU delegate. The screenshot matrix runs serially in the same run, on one machine. Screenshots (phone and desktop, light and dark, both languages, one per skin at least) go to a local directory outside git and are never committed.

## 11. Repository hygiene

- Commits follow Conventional Commits with a short natural subject and a body only when it explains why; no bullet dumps and no internal ids (use `Refs: #123`). PR descriptions: a few lines for what, why and how to verify, plus the issue link. Issues are concise with acceptance criteria. Code comments only where they explain intent. The standard attribution trailer and PR footer stay.
- `docs/decisions.md` becomes a neutral decision log (date, topic, decision, reason). Remove tool, process and role wording from `README.md`, `CONTRIBUTING.md` and `docs/`.
- Enable automatic deletion of head branches and delete remote branches whose PR is merged or closed. Never rewrite or force-push `main`.

## 12. Quality and performance

Backend: no N+1 queries (batch or join); indexes for the queries the new read routes use; pagination on every list; idempotent event handlers; timeouts and bounded retries on every outbound call (model, Google, CalDAV, chat channels); one place per rule, with no duplicated money or penalty logic; input validated at the edge with contract schemas; errors that name what failed.

Frontend: server components by default and client components only for interaction; data fetched once per screen and shared; skeletons to avoid layout shift; images sized per viewport and lazy-loaded; transform and opacity animation only; the dashboard stays responsive on a mid-range phone.

Tests stay first. Measured things (query count, bundle size, a slow route) get a cheap regression check. Package-scoped commands only: `pnpm --filter <package> test|typecheck|lint`.

### Memory and size cost

| Item | Cost | Note |
|---|---|---|
| CSS tokens, skins, modules | about 40 KB CSS, no JS | plain CSS variables and CSS Modules |
| Hand-written client controls (mode, skin, locale, sheets, nav) | under 20 KB gzip | no library |
| Fonts (two families, subset) | about 150 KB on disk, loaded on demand | `next/font/local` |
| Art route handler | streams files, one small in-memory file-list cache | variants pre-generated by a local script into the private directory; no image library at run time |
| Companion and speech text | no dependency | uses the existing `ai` service |
| Google Sheets client (`sync`) | one HTTP client, no SDK if REST is enough; otherwise record the SDK size here | outbound timeouts and retries |
| CalDAV client (`sync`) | a small client library or hand-written PROPFIND and PUT; the chosen option and its size are recorded in ADR 0015 | no background process |
| Command parser | pure functions, no dependency | |

The web container keeps its 256 MB limit and a 192 MB heap cap. Idle and end-to-end RSS is measured and recorded; if too high, features give way first and raising the limit needs an ADR. A dependency that is added without a line in this table or its ADR is rejected in review.

## 13. Issue outline

Order: locale bugs and gateway wiring, design system and skins, screens, sheets and sync, chat commands, hygiene. Each issue is one vertical slice and one PR, with tests first and package-scoped checks. "Area" names the service or package. Risk is low unless stated. Prerequisite of every issue that touches art (12, 13, 14, 18 to 25): the ignore rules for `docs/image/` and `.private-assets/` are on `main`.

**A. Locale bugs and gateway wiring**

1. Request locale everywhere. Area: web. Depends on: none.
   - Given English is chosen, when any page renders, then `html[lang="en"]` and no `vi` catalog string appears.
   - Given `/locale?next=...` with an unsafe path, then it redirects to `/`; with a valid path, back to that page (table test).
   - The segmented `VI | EN` control highlights the active language; `UI_LANGUAGE` is read in one file; the language is also stored in the profile and written to the cookie at the next visit.
2. Demo state persistence and API probe. Area: infra. Depends on: none. Risk: medium.
   - Given `pnpm demo:reset`, when the stack restarts, then the cycle, ten blocks and two routines remain.
   - The probe logs in via `/demo-login` and records the status of every API path the web uses.
3. Gateway upstreams for `ai`, `notify`, `ingest`, `monitor` and the `/weeks` prefix. Area: gateway. Depends on: 2.
   - Given each prefix, when called through the gateway, then the upstream answers (one test per prefix).
4. Service read routes: notify `GET /inbox`, rules `GET /faults`, ai `GET /keys`. Area: notify, rules, ai. Depends on: 3. Risk: medium.
   - Given the demo user, when each route is called, then the body parses with the shared fixture schema.
   - Lists are paginated and indexed.
5. Budget overview and funding for the demo user. Area: budget. Depends on: 2, 3. Risk: medium.
   - Given the demo user, when overview and funding are requested, then a running cycle and the transfer list return.
6. `rules` consumes `incident.*`. Area: rules. Depends on: 2.
   - Given an `incident.*` event, then overlapping faults are waived; redelivery is a no-op.
7. Dev runner forwards `cycle.opened` and `fault.detected`. Area: infra. Depends on: 2.
   - Given a cycle opens in the dev runner, then `rules` receives the event.
8. Follow-up ADR: move the web-local read-route shapes and the profile and settings shapes (`appearance.*`, `appearance.expression_map`, `persona.*`, command settings) into `packages/contracts`. Area: contracts. Depends on: 4, 15, 16, 41. Risk: medium.
   - Given the ADR is accepted, then web and the producing services import the same schemas and the local copies are deleted.

**B. Design system and skins**

9. Tokens, skins, modes and the contrast test. Area: web. Depends on: 1.
   - Given any of 4 skins x 2 modes, then every pair meets WCAG AA (unit test).
   - Given the cookies `mw_skin` and `mw_mode`, then the server renders the right attributes with no flash.
10. Fonts and base components (Button through ErrorState). Area: web. Depends on: 9.
    - Given the build, then no font CDN request exists; controls are at least 44 px with visible focus.
11. App shell: top bar, pill nav, bottom bar, More sheet, route-to-area test. Area: web. Depends on: 10.
    - Given 360 and 1440 px, then no horizontal scroll; admin items are hidden for non-admins.
12. Private art loader, fallback theme and credits screen. Area: web. Depends on: 10.
    - Given `MASCOT_ART_DIR` is unset, then the fallback theme renders, the credits screen shows a generic note and CI passes.
    - Given a signed-out request for an art file, then 401; path traversal is refused.
    - Given the directory has only originals, then originals are served.
13. Local script that generates size variants into the private directory. Area: infra. Depends on: 12.
    - Given the script runs on the private directory, then each image has variants; nothing is written inside the repository.
14. Expression sets, mapping and settings screen. Area: web, identity (settings keys). Depends on: 12. Risk: medium.
    - Given a set switch, then the per-state mapping is kept.
15. Appearance settings: skin and mode persisted to cookie and profile. Area: web, identity. Depends on: 9, 11.
    - Given a skin change, then every screen uses it at once.
    - Given `system` mode, then art uses `prefers-color-scheme` sources and no dark flash occurs.

**C. Screens**

16. Persona address terms: lists, settings screen, placeholders in locale files. Area: web, ai. Depends on: 10.
    - Given a custom term or a removed default, then it is honoured in both locales.
17. LLM-written text with the number check, the fixed fallback and the per-screen remark cache. Area: ai. Depends on: 16. Risk: high (principle 4).
    - Given a wrong amount in the generated text, then the fallback sentence is sent.
    - Given the same user, screen and day, then the remark is generated once and cached; a failed generation caches the fixed fallback.
    - Given degraded mode or a timeout, then the fallback is used.
18. Companion panel and speech bubble. Area: web. Depends on: 11, 12, 17.
    - Given any screen except the dashboard and the focus session, then the panel shows the cached remark or the fallback.
19. Dashboard and mascot animation. Area: web. Depends on: 4, 5, 12, 14, 17, 18.
    - Given a task tick, then the check pop plays, the bar advances and a `role="status"` reaction is announced.
    - Given `prefers-reduced-motion`, then no animation runs.
20. Schedule screens with block details, calendar tabs and weekly review. Area: web. Depends on: 11, 18.
21. Focus session screen. Area: web (realtime). Depends on: 11. Risk: medium.
    - Given a session, then the ring follows the server clock and the privacy note shows; video is never sent.
22. Budget screens and the transfer-list wording. Area: web. Depends on: 5, 11, 18.
    - Given either catalog, then the banned-wording lists find no match (the funding keys are reworded).
23. Routines screen. Area: web. Depends on: 11, 18.
24. Messages screen with stickers and inline answers. Area: web. Depends on: 4, 11, 14, 18.
25. Skeletons, empty and error states on all screens. Area: web. Depends on: 19 to 24.
26. All-screens end-to-end test. Area: e2e. Depends on: 1, 3 to 7, 19 to 25.
    - Given a demo login, when every route is visited, then there is no 4xx or 5xx API response, no error alert, no console error and no horizontal scroll at 360 px.

**D. Sheets and sync**

27. Contracts for ADR 0015 (cell edit, conflict record, calendar provider, events, consent). Area: contracts. Depends on: none. Risk: high.
28. Timetable sheet endpoints: read cells and write an editable cell. Area: schedule. Depends on: 27. Risk: medium.
    - Given a past week or a computed cell, then the write is refused; given an editable cell, then the schedule changes.
29. Timetable sheet screen. Area: web. Depends on: 20, 28.
30. Budget sheet endpoints: read the five tabs and write plan cells only. Area: budget. Depends on: 27. Risk: high.
    - Given a booked transaction, fault or penalty cell, then the write is refused.
31. Budget sheet screen. Area: web. Depends on: 22, 30.
32. Sheet sync part 1: protected ranges, read-back validation, the off switch and the malformed-sheet pause. Area: sync. Depends on: 28, 30. Risk: high.
    - Given an edit to a locked cell in the Google Sheet, then it is reverted at the next sync.
    - Given a malformed sheet, then read-back pauses and the user is asked.
    - Given cell text that looks like an instruction, then it is treated as data.
33. Sheet sync part 2: last-write conflicts, audit record of both values and the inbox notice. Area: sync, notify. Depends on: 32.
    - Given two edits to one cell, then the last write wins, both values are audited and a notice appears in Messages.
34. Calendar choice setting and provider abstraction. Area: sync, web. Depends on: 27.
    - Given Google, Apple, both or none, then only the chosen providers receive events.
35. Apple Calendar through CalDAV. Area: sync. Depends on: 34. Risk: high.
    - Given Apple is chosen, then the schedule is pushed with the Google mirror's acceptance tests.
    - Given revoked consent, then no further calls are made; the app-specific password is encrypted at rest and never logged.

**E. Chat commands**

36. Contracts for ADR 0016. Area: contracts. Depends on: none. Risk: high.
37. Parser, registry and control commands (`/help`, `/status`, `/usage`, `/new`, `/stop`, `/lang`, `/strict`, `/quiet`, `/skin`, `/model`). Area: ai, notify. Depends on: 36.
    - Given a command with an alias or a disabled command, then it resolves or is refused as configured.
    - Given `/lang en` from a chat, then the profile language changes.
38. Capture commands with named write paths. Area: ai, budget, schedule. Depends on: 37.
    - `/spend` calls the budget cash-spend recording route and `/task` calls the schedule task-creation route (the same routes the quick-capture tool uses); `/remember` and `/forget` use the memory routes of `ai`. No new write path is added outside these services.
    - Given the same text in a forwarded email, then nothing runs.
39. Summary and rules commands (`/summary`, `/today`, `/week`, `/budget`, `/appeal`, `/reason`). Area: ai, rules. Depends on: 37.
40. Mood tags. Area: ai. Depends on: 37, 14.
    - Given `/angry` plus a message, then the mood is stored and money, faults and penalties are unchanged.
41. Command descriptions in the model context and custom commands (prompt, mood, shortcut, try, delete). Area: ai. Depends on: 37.
    - Given a custom prompt command, then the description and `{text}` reach the model context.
42. Command settings screen. Area: web. Depends on: 11, 41.
43. Telegram and Discord menu registration and in-app autocomplete. Area: notify, web. Depends on: 41, 24.
    - Given a disabled command, then it is removed from the menu.

**F. Hygiene and verification**

44. Neutral decision log and docs wording cleanup. Area: docs. Depends on: none.
45. Repository settings: delete head branches; remove stale remote branches. Area: infra. Depends on: none.
46. Quality pass: N+1 and index review, pagination, timeouts and retries on outbound calls, memory measurement. Area: backend, web. Depends on: A to E. Risk: medium.
47. Final verification: locale and all-screens suites across skins, modes and widths; local serial screenshots; a walk-through of the manual part of `docs/acceptance-guide.md` on a fresh demo with the art directory configured. Area: e2e. Depends on: A to E, 46.
