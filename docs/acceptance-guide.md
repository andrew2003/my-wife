# Acceptance guide

A step-by-step way to verify the four demo scenarios (see `factory/prompts/milestones.md`):
onboarding, money, time and routines. Each scenario has two parts: an automated check you can run
in one command, and a manual walk-through in the web app.

Only commands and screens that exist today are listed. Where something is not implemented, the
step says so. Screens may show empty states while some read routes are missing (see the known gap
note in `README.md`).

## 0. Prerequisites

- Node 22 or newer, pnpm 10, and Docker for the shared infrastructure stack.
- `pnpm install` from the repository root.
- Do not start a second infrastructure stack. The automated end-to-end run uses its own database
  name (`E2E_DB_NAME`, default `mywife_e2e`) on the shared stack.
- Run one thing at a time and stop everything you started when you are done (Ctrl+C).

## 1. Fast path: run the automated scenarios

```sh
pnpm --filter @my-wife/e2e test
```

This one command (`apps/e2e/scripts/run.mjs`) does the following, in order:

1. Creates the fake camera video.
2. Resets the end-to-end database.
3. Builds the web app for production with `UI_LANGUAGE=en`.
4. Runs the Playwright suite (Chromium, headless, one worker). This covers the onboarding
   scenario and the web smoke tests.
5. Runs the Vitest scenarios for money, time and routines. They drive the services in process on
   simulated time, so they need no browser.

Extra arguments go to Playwright, for example
`pnpm --filter @my-wife/e2e test tests/onboarding.spec.ts`.

The automated scenario files are `apps/e2e/tests/onboarding.spec.ts`, `money.spec.ts`,
`money-extended.spec.ts`, `time.spec.ts`, `time-extended.spec.ts`, `routines.spec.ts` and `onboarding-extended.spec.ts` (account lifecycle: checklist, contract per cycle, export, deletion, admin incident). Each
step name in them matches a step below. A scenario passes when every step passes.

## 2. Manual path: start the demo

Run each command in its own terminal from the repository root. This is the same procedure as
"Manual demo" in `README.md`.

```sh
pnpm demo:reset                                       # 1. build and print the demo state
pnpm --filter @my-wife/web build                      # 2. production build of the web app (once)
DEMO_LOGIN=1 DEV_RUNNER_NO_NATS=1 pnpm dev            # 3. all services (ports 4000-4009, sign-in helper on 4100)
pnpm --filter @my-wife/web start                      # 4. web app on http://localhost:3000
xdg-open http://localhost:4100/demo-login             # 5. sign in as the demo account
```

- Use `localhost`, not `127.0.0.1`, in the browser: the session cookie is set for the host you
  open.
- `DEMO_LOGIN=1` is for the demo only; the runner refuses to start with `NODE_ENV=production`.
- The runner resets the demo user in its own in-memory store at startup. The demo state is the
  user `demo@example.test` (locale `vi`) with a running four-week budget cycle, a sample day
  schedule, a wake and a bedtime routine, and emulated chat channels.
- Rebuild the demo state at any time by stopping step 3 and starting it again; `pnpm demo:reset`
  previews it.
- For English, build the web app with `UI_LANGUAGE=en pnpm --filter @my-wife/web build` (pages are
  prerendered, so the locale is fixed at build time). The default is Vietnamese.

To check the deploy path, see `docs/deploy.md`:
`DEPLOY_TARGET=this_server scripts/deploy-demo.sh --check` validates the intake and the compose
config without starting containers. The real deploy needs owner-provided values and a Cloudflare
Tunnel, so agents never run it.

Optional tools for the money scenario, run from the repository root:

```sh
pnpm --filter @my-wife/test-kit seed                  # seed data
pnpm --filter @my-wife/test-kit inject-emails --list  # list the sample bank emails
pnpm --filter @my-wife/test-kit inject-emails         # send them to the ingest webhook
```

`inject-emails` posts to `http://localhost:4003/webhook/inbound-email` (the ingest port) unless
`INGEST_WEBHOOK_URL` is set; give the webhook secret with `--secret` or `INGEST_WEBHOOK_SECRET`.

## 3. Scenario 1: onboarding

Goal: sign in, product tour with a Skip button, setup questions, a generated sample schedule and
sample budget, signing the commitment contract.

Automated: `apps/e2e/tests/onboarding.spec.ts`.

Manual (the demo account may already be set up; if the tour does not appear, open `/onboarding`
directly):

1. Open the web app after signing in. Expect: the product tour dialog with a Skip button and no
   sign-in link.
2. Click Skip. Expect: the tour closes and the navigation bar is visible.
3. Open `/onboarding`. Expect: the heading "Set up your day and budget" and the setup questions.
   Every question can be skipped; a skipped answer uses the standard template.
4. Answer or skip the questions and click Continue. Expect: a review page with
   - a sample schedule whose wake block is at 06:30 (the default wake time), and
   - a sample budget with a category list and the text "4 weeks from <date>" (the default cycle
     length).
5. Continue to the contract (`/contract`). Expect: the commitment contract. Click Sign.
6. Expect: you land on the home page.

Not implemented or partial: real Google sign-in needs real credentials and is not part of the
demo; the demo uses the sign-in helper on port 4100. Starter packs and the setup checklist exist
as `identity` service routes; how far the screens use them is not covered here.

## 4. Scenario 2: money

Goal: open a budget cycle, fund it by QR transfer and receipt, a spend with a transfer code, an
unknown spend, an international card payment, overspending, a suspended penalty, paying the
penalty.

Automated: `apps/e2e/tests/money.spec.ts` and `money-extended.spec.ts` (run by
`pnpm --filter @my-wife/e2e test`). Steps and expected results:

1. The sample budget draft exists and the accounts are confirmed by test receipts.
2. Funding every account opens the cycle, once.
3. A coded spend (a transfer whose memo carries a category code) is booked in its category.
4. An unknown spend asks for a category and is booked on the answer.
5. A foreign card payment is booked once, from the debit.
6. Overspending a want category is found when the week closes.
7. The penalty is suspended while the trial runs and asks for no payment.
8. The suspended penalty becomes due, and then it is paid. The bot only reads the receipt to
   verify; it never moves money.

Manual, in the web app (screens: `/budget`, `/budget/funding`, `/receipts/<id>`, `/inbox`,
`/anomalies`, `/penalties`, `/debts`, `/cycle-close`):

1. Open `/budget`. Expect: the running demo cycle, its categories with limits, recent
   transactions.
2. Open `/budget/funding`. Expect: the funding screen for the cycle.
3. Run `inject-emails` (section 2) to send sample bank emails, then open `/inbox` and `/budget`.
   Expect: matching transactions booked, a coded transfer in its category, unknown spends waiting
   for a category.
4. Open `/anomalies`. Expect: unknown spends and anything that needs your attention.
5. Open `/penalties` and `/debts` after a week closes with overspending. Expect: a suspended
   penalty with no payment due during the trial.

Not implemented or partial: the week close and the penalty trial depend on time. The manual demo
runs on the real clock, so steps 5 to 8 of the automated list cannot be reached by hand in one
session. Use the automated run, which fast-forwards time with the test-kit time simulator
(`packages/test-kit/src/clock.ts`). Some budget read routes are missing, so screens may show
empty states (issues #244, #247, #271, #273).

## 5. Scenario 3: time

Goal: daily checklist, per-second countdown, camera focus monitoring, urgent message and reason,
fault points, weekly review.

Automated: `apps/e2e/tests/time.spec.ts`, `time-extended.spec.ts`, `camera-heartbeats.spec.ts`
and `hidden-tab-countdown.spec.ts`. Steps and expected results:

1. A planned week gives a checklist of the day.
2. Ticking a task done emits `task.ended` and sends no chat message.
3. The countdown runs on the server clock and ends once.
4. Monitoring with a steady fake camera raises nothing.
5. Losing the camera sends one urgent message and no fault yet.
6. An honest reason within the delay answers the ticket at a lower score.
7. A silent loss escalates to chat and becomes one scored fault.
8. Ending monitoring closes the session.
9. The week closes once, and its review has the numbers from code.
10. No business code reads the system clock.

Manual, in the web app (screens: `/schedule`, `/schedule/today`, `/schedule/calendar`,
`/schedule/review`, `/monitor`, `/faults`):

1. Open `/schedule/today`. Expect: "Today's checklist". Tick a task.
2. Open `/monitor` and start focus monitoring. Expect: a per-second countdown. Allow the camera
   when the browser asks. Video stays on your device and images are not stored. Without a GPU the
   analysis uses the CPU delegate.
3. Cover or disconnect the camera. Expect: an urgent message asking for a reason. An honest reason
   within the delay gives a lower score; no reason becomes a fault.
4. Open `/faults`. Expect: the scored faults.
5. Open `/schedule/review`. Expect: the weekly review with tasks, faults and spending.

Not implemented or partial: the weekly review needs a closed week, which needs simulated time
(automated run only). The real camera path needs a physical camera; the automated suite uses the
fake camera video made by `apps/e2e/scripts/make-fake-video.mjs`.

## 6. Scenario 4: routines

Goal: bedtime reminder, wake-up photo with a random challenge, confirmation recorded for both
sides.

Automated: `apps/e2e/tests/routines.spec.ts`. Steps and expected results:

1. Both users have a planned week, so the jobs consider them.
2. No reminder goes out before the lead time.
3. The bedtime reminder reaches each chat (Telegram and Discord emulators) once.
4. The night is quiet until the wake time.
5. At wake time each chat gets a challenge.
6. Discord: a photo at once is graded and confirmed on time.
7. Telegram: a photo two minutes later is confirmed with the lateness.
8. A graded day stays closed and adds no fault and no urgent message.

Extended: `apps/e2e/tests/routines-extended.spec.ts` covers levels (a meal at `off` never appears,
`remind` only sends a message, raising wake to `commit` is immediate, lowering waits for next
week), the late-night label (one reminder, no fault), quiet hours (the reminder is held back, the
wake challenge still arrives, a normal reminder passes at 06:30), an unclear photo (another photo
is requested, nothing recorded) and a late wake (14 minutes is recorded, 16 minutes with a
15 minute grace emits `routine.late_detected`).

Manual, in the web app (screens: `/routines`, `/routines/sleep`):

1. Open `/routines`. Expect: "Routine levels".
2. Open `/routines/sleep`. Expect: the sleep and wake-up settings with the bedtime and the wake
   time (defaults `routine.sleep.start` and `routine.wake.time`).

Not implemented or partial: reminders and the wake-up photo go through chat channels. The demo
uses emulated Telegram and Discord servers, so there is no real chat to read by hand; the chat
side is verified by the automated run. Real Telegram and Discord need bot tokens from the owner.

## 7. Sign-off checklist

- [ ] `pnpm --filter @my-wife/e2e test` passes (all four scenarios).
- [ ] Each manual walk-through reaches its expected screen and result, or the gap is the one
      listed under "Not implemented or partial".
- [ ] Every process you started is stopped.
