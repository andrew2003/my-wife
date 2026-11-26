# Milestones

Scope: build everything the spec describes, except the items marked "after the demo" and Zalo. The order below removes nothing; it only makes something runnable exist early.

Four demo scenarios are the yardstick throughout:

1. **Onboarding:** sign in, product tour (with a Skip button), setup questions, a generated sample schedule and sample budget, signing the commitment contract.
2. **Money:** open a budget cycle, fund it by QR transfer and receipt, a spend with a transfer code, an unknown spend, an international card payment, overspending, a suspended penalty, paying the penalty.
3. **Time:** daily checklist, per-second countdown, camera focus monitoring, urgent message and reason, fault points, weekly review.
4. **Routines:** bedtime reminder, wake-up photo with a random challenge, confirmation recorded for both sides.

## M0 — Spec audit and scaffolding

Sequential, in this order:

1. `spec-auditor` audits everything in `docs/spec/` and `docs/source/`. Output: a list of contradictions and gaps. Where a safe option exists, `po` decides and logs it. Anything that falls under the six ask-the-owner cases is merged into **one** question file with `blocking: milestone`.
2. `architect` writes the domain specs **in English** from the Vietnamese source: `docs/spec/10-budget.md`, `11-ingest.md`, `12-rules.md`, `20-schedule.md`, `21-monitor.md`, `22-routines.md`, `30-ai.md`, `31-notify.md`, `40-identity-onboarding.md`, `41-sync.md`, `50-admin.md`. Use the glossary in file `00`. File `00` wins on any conflict; `docs/source/` is archived reference material.
3. `architect` writes ADRs for the agreed architecture decisions (`docs/adr/`) and `packages/contracts`: zod schemas for every API, event and enum.
4. `builder-service` builds the skeleton:
   - pnpm + Turborepo monorepo: `apps/web`, `services/<name>`, `packages/contracts`, `packages/config`, `infra/`.
   - A service template (Fastify, health check, JSON logs with a trace ID, NATS connection, Drizzle, tests) and a command that generates a service from it.
   - Ten empty services: gateway, identity, budget, ingest, schedule, monitor, rules, ai, notify, sync.
   - Docker Compose: PostgreSQL with pgvector, Redis, NATS JetStream, the services, the web app, with the memory limits from the resource budget in `CLAUDE.md`.
   - `apps/dev-runner`: one Node process that mounts all ten services for development and end-to-end tests.
   - Resource limits configured in the repository: Turborepo concurrency 2, Vitest `maxWorkers: 2`, incremental `tsc` with project references, a 2 GB Node heap cap in build and test scripts.
   - Sign-in according to `LOGIN_METHOD`, invitation-only sign-up.
   - Internationalization with `vi` and `en` locale files; `UI_LANGUAGE` is the default locale.
5. `builder-service` builds the test tooling: a time simulator (fast-forward weeks and cycles), seed data, emulated Telegram and Discord servers, and a command that injects sample emails into the ingest webhook.
6. `qa` sets up the Playwright suite (Chromium only, headless, `workers: 1`, production build of the web app, CPU delegate for camera analysis) with a fake camera that plays a sample video, and one smoke test that goes through the web app, the gateway, one service and the database.
7. `builder-service` sets up GitHub and the Git conventions:
   - Create the repository if allowed, CI (lint, typecheck, tests, contract checks, build), branch protection for `main`, PR and issue templates, labels, Dependabot, secret scanning.
   - Enforce Conventional Commits: commitlint with the conventional config, a `commit-msg` hook (husky or lefthook), a CI job that lints every commit of a PR, and a CI job that lints the PR title.
   - Squash merge only, linear history, release-please for versions and `CHANGELOG.md`.
   - `CONTRIBUTING.md`, `README.md`, `.editorconfig`, ESLint and Prettier configuration, and a `LICENSE` placeholder to be confirmed by the owner.
8. `architect` installs factory hooks and skills under `.claude/` (not in `.claude/agents/`, which is generated): run typecheck and tests for the changed package; block edits to `packages/contracts` and `.env` files outside an issue that allows them; block deleting or skipping tests.
9. `architect` generates `factory/backlog.json` for **all** of M1–M4 (and creates the GitHub issues when `GITHUB_MODE=full`). Each entry:

```json
{
  "id": "MW-042",
  "title": "Record a coded transfer in the matching budget category",
  "milestone": "M1",
  "agent": "builder-core",
  "service": "budget",
  "risk": "high",
  "deps": ["MW-017"],
  "spec": "docs/spec/10-budget.md#reconciliation",
  "acceptance": ["Given ... When ... Then ..."],
  "status": "todo",
  "issue": 57,
  "pr": null
}
```

`status` is one of: `todo`, `doing`, `review`, `done`, `blocked`. Each issue fits in one small PR and cuts from the UI to the database for one visible behavior.

**M0 is done when:** CI is green, `docker compose up` runs everything within the memory limits, the dev runner starts all services in one process, the smoke test is green, commit and PR title lint are enforced, and `backlog.json` covers M1–M4.

## M1 — Walking skeleton of the four scenarios (first demo)

Each scenario runs end to end along the happy path; error handling and edge cases come later. Includes both Telegram and Discord at basic send-and-receive level, and the AI service with one provider and minimal persona and memory.

**M1 is done when:** the four scenarios are green on `main` with simulated time, and one command rebuilds the demo state.

## M2 — Money, complete

The eight-step unknown-receipt pipeline, self-learning receipt templates with promotion and demotion, every transaction type in the spec (international card, internal transfer, refund, cash withdrawal, bank fees), debts, shared group expenses and income, weekly balance reconciliation, exceptions and the contingency fund, end-of-cycle surplus split, overspending penalty, trial mode with suspended penalties, penalty savings, transfer QR codes, weekly menu and shopping list, a Google Sheet per cycle, inbound mail through Cloudflare Email Routing with DKIM verification.

**M2 is done when:** the extended money scenario (including failure branches and appeals) is green, and the table-driven tests for every money rule are green.

## M3 — Time and monitoring, complete

Weekly schedule with templates, recurrence on the solar and lunar calendars, carry-over rules, sub-tasks, pomodoro, picture-in-picture window, end-of-task sound, web push, the solar and lunar calendar tab, Google Calendar sync, in-browser camera monitoring, heartbeat, escalating urgent messages, reasons with quotas, the fault ledger and penalty thresholds, waivers, appeals, offline tasks, weekly review with scheduling suggestions, tapering supervision.

**M3 is done when:** the extended time scenario is green on Chrome, and the automated test shows the countdown stays correct to the second while the tab is hidden.

## M4 — Routines, AI, onboarding, admin, deployment (full demo)

Routines with four levels, the sleep and wake flow, the wake-up photo with a challenge and AI grading, bring-your-own-key with several providers, model switching with a handover test and fallback, structured memory and summaries, persona strictness, quick capture in chat, morning and evening digests, quiet hours, the in-app inbox, complete onboarding (tour, preview account, setup checklist with real checks, template sets), the per-cycle commitment contract and the loosening lock, a simple reward mechanism, the admin page, degraded mode when the LLM fails, personal data export and deletion, and deployment of the demo through Cloudflare Tunnel according to `DEPLOY_TARGET`.

**M4 is done when:** all four extended scenarios are green, the demo runs at a real address (if the intake form is complete), and a step-by-step acceptance guide exists.

## After the demo (not part of the milestones above)

Accountability partner, camera spoofing countermeasures, importing existing Google Calendar events as busy blocks, bill and subscription reminders, the "bad day" button, cycle report, voice messages, Zalo.
