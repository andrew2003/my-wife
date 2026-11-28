# Identity and onboarding

Owner: `identity` (accounts, sessions, settings, consents, keys, invitations, export/delete) with the gateway in front. Onboarding screens live in `apps/web` and call `identity`, `schedule`, `budget` and `rules`.

## 1. Sign-in and invitations

- Sign-up is by invitation only. An invitation has a token, an expiry (`identity.invitation_ttl_days`), and is single-use. `identity.max_users` caps the active user count.
- `LOGIN_METHOD` (setup form) is `google` (Google sign-in) or `magic_link` (an expiring link to the invited email, `identity.magic_link_ttl_minutes`). Sessions last `identity.session_ttl_days`. The gateway is the only external entry point and verifies the session.
- Google scope for Sheets and Calendar integration is the narrow `drive.file` scope plus Calendar events (see `41-sync.md`); that is a separate consent from sign-in.

Account state machine: `invited` -> `active` -> `closing` -> `closed`; also `suspended` (admin).

| From | Trigger | To |
| --- | --- | --- |
| `invited` | user accepts a valid invitation | `active` (default settings created) |
| `active` | user requests deletion | `closing` after an export is offered |
| `closing` | no suspended or due penalty remains | `closed` (personal data erased, anonymized audit remains) |
| `closing` | suspended or due penalties remain | stays `closing` with only the penalty ledger and payment verification until settled; trial ends immediately |
| `active` | admin suspends | `suspended` |

Deleting the account never erases suspended penalties (final decision).

## 2. Settings

`identity` stores the per-user settings table and publishes `user.updated` with a changed-keys list. Every business setting in `02-defaults.md` is a setting with a default and an owner service. Changes go through one function that classifies the change as tightening or loosening (the rule function lives in `rules`); loosening carries an `effective_from`. Each change is written to `audit_log`.

Settings include: time zone, locale (`vi`, `en`, default from `UI_LANGUAGE`), channel and quiet hours, week start day, supervision windows, routines, budget settings, model choices. The change history is visible to the user.

## 3. Consents

Separate, revocable, versioned consents with a text version: `camera` (face analysis in the browser), `vision_frame` (single frame to a vision model on appeal or ambiguity), `wake_photo` (photo through chat and an LLM provider), `email` (forwarded bank mail), `bank` (reading transaction facts), `google_sync` (Sheets and Google Calendar), `apple_calendar_sync` (Apple Calendar through CalDAV, with an app-specific password stored encrypted). A feature that needs a consent is unavailable until granted, and revoking it stops the feature immediately. Changing the consent text means requesting consent again.

## 4. Keys and tokens

LLM keys and Google tokens are encrypted at rest (AES-256-GCM, master key from an environment variable, `key_id` per row for rotation), never returned by any API, never logged. A key is verified by a test call when saved.

## 5. Tenancy

Every table has `user_id` with PostgreSQL row-level security. A request carries the verified user id; services set it on the connection for each request.

## 6. Export and deletion

The user can download all of their data (machine-readable archive) at any time; the archive link lives `identity.export_ttl_hours`. Deletion follows the account state machine above.

## 7. Onboarding

First sign-in flow, every step skippable, reopenable from settings:

1. **Tour** of each screen (schedule, budget, inbox, settings).
2. **Demo account:** read-only-ish sample data so the user can click everything before configuring.
3. **Setup checklist**, each step with a real check:
   - Connect Telegram or Discord: the bot sends a test message.
   - Enter an LLM key: the bot makes a test call.
   - Create the bank mail forwarding filter: wait for a test mail (and show the Gmail confirmation code).
   - Allow notifications and the camera; install the web app on the home screen; allow the bot to ring during Do Not Disturb.
4. **Q&A to generate templates** (every question skippable).
5. **Review and sign the commitment contract**, start trial mode.

Questions and defaults:

| Template | Questions | If unanswered |
| --- | --- | --- |
| Schedule | Fixed work or study hours, preferred wake-up time, sleep hours, meals, recurring activities, best focus hours | Standard day template |
| Budget | Total budget or income per cycle, weeks per cycle, fixed expenses, savings goal, banks in use | Standard category set split by sample ratios |

Starter packs: student, regular-hours worker, freelancer with irregular income. Routine levels in the starter: sleep and meals at `track`; wake-up at `remind`, the user opts into `commit`.

Standard day template (every time editable):

| Time | Block | Type |
| --- | --- | --- |
| 06:00 | Wake up, check-in photo | routine |
| 06:00-07:30 | Hygiene, exercise, breakfast | routine |
| 07:30-07:45 | Pick the top three tasks | daily rhythm |
| 08:00-12:00 | Deep work in pomodoro sessions | work, monitored |
| 12:00-13:30 | Lunch and rest | routine, flexible |
| 13:30-17:30 | Work | work, monitored |
| 17:30-19:30 | Exercise, dinner | routine, flexible |
| 19:30-21:30 | Study or personal project | work, optional monitoring |
| 21:30-22:00 | Reflection, close the checklist | daily rhythm |
| 23:00 | Sleep | routine, fixed |

The standard budget category set follows the sample set in `10-budget.md` (food, fixed bills, transport, health and personal care, eating out, entertainment, small shopping, contingency fund, savings, future purchases, penalties).

## 8. Events

Published: `user.invited`, `user.activated`, `user.updated`, `user.suspended`, `user.closing`, `user.closed`, `consent.granted`, `consent.revoked`, `llm_key.saved`, `llm_key.invalid`, `onboarding.step_completed`, `export.ready`.

Consumed: `incident.*` (display), `penalty.*` (closing gate), `trial.ended`.

## 9. Acceptance

1. Given an invitation older than its TTL, When the user opens it, Then sign-up is refused.
2. Given consent `camera` is revoked, Then monitoring with camera is unavailable at once and the level drops to `no_camera`.
3. Given a stored LLM key, Then no response contains it.
4. Given a user with suspended penalties requests deletion, Then the account stays `closing` and trial ends.
5. Given two users, Then user A cannot read user B's rows even with a direct query using A's session (RLS test).
6. Given a skipped Q&A, Then the standard templates are generated and editable.
