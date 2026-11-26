# Routines

Owner: the routines layer is implemented in `schedule` (blocks, levels, flows, check-ins), uses `notify` to deliver messages, `ai` to grade wake-up photos and `rules` for `commit`-level penalties. Routines are sleep, meals and rest, kept separate from work tasks. By default: no camera and no penalty.

## 1. Levels

Per routine (sleep, wake-up, each meal, exercise, others the user adds): `off`, `remind`, `track`, `commit`.

| Level | Bot does | Penalty |
| --- | --- | --- |
| `off` | Nothing; the routine does not appear in the schedule | None |
| `remind` | Sends a message on time | None |
| `track` | Reminds and asks for a check-in ("ate", "up"); recorded for the weekly review | None |
| `commit` | Reminds, check-in with a deadline, escalates when late | Yes, from rules and thresholds the user sets; only on check-in times (hard facts) |

Defaults in the starter template: sleep and meals at `track`; wake-up at `remind`, and the user opts into `commit`. Raising a level takes effect immediately; lowering a level from `commit` is loosening (next week). A routine not enabled never appears.

## 2. Blocks

- **Fixed block:** a held time, for example sleep 23:00-06:30.
- **Flexible block:** a window plus a duration, for example lunch 30 minutes within 11:30-13:30; the planner places it in the gap between tasks.
- **Day profiles:** weekday and weekend have different times. Special modes relax automatically.
- The weekly planner places routine blocks first, then tasks. Not enough room produces "overloaded week" at planning time.
- No work in sleep time unless confirmed separately; each confirmation is counted in the weekly review.
- A pomodoro break, a meal block and a long break are valid and pause monitoring without fault.
- Working through a meal window prompts a meal break; repeated skipping (`routine.skipped_meals_flag`) shows in the weekly review and is not penalized. If the budget service has a menu, the reminder names today's dish.

## 3. Sleep and wake-up flow (times are settings)

State machine of one night, `sleep_night`:

`idle` -> `winddown` -> `bedtime_reminded` -> `sleeping` -> `wake_due` -> `awaiting_proof` -> `awake` | `late` | `missed`.

| From | Trigger | To | Effects |
| --- | --- | --- | --- |
| `idle` | `routine.winddown_lead_minutes` before bedtime | `winddown` | "Prepare to end the day": close checklist, view tomorrow |
| `winddown` | `routine.bedtime_lead_minutes` before bedtime | `bedtime_reminded` | Remind; if a session is active the web shows an end-of-session countdown |
| `bedtime_reminded` | bedtime | `sleeping` | Web switches to the bedtime screen and stops monitoring; quiet hours start |
| `sleeping` | web still active after bedtime | `sleeping` | Remind once and label `late_night` (soft) with quick reasons (urgent work, cannot sleep) |
| `sleeping` | wake time | `wake_due` | Send the wake message with "I am up" button, or a challenge photo prompt |
| `wake_due` | no check-in | `wake_due` | Resend every `routine.wake_nudge_interval_minutes` up to `routine.wake_nudge_max` with escalating tone |
| `wake_due`/`awaiting_proof` | accepted check-in | `awake` | Wake time = time the accepted proof was sent |
| `wake_due` | grace `routine.wake_grace_minutes` passes with no accepted check-in | `late` | Record "woke X minutes late"; at `commit` emit `routine.late_detected` |
| `late` | check-in arrives later | `awake` | Lateness is kept |
| any | day ends with no check-in at all | `missed` | Record only |

Optional anti-resleep: a second check-in after `routine.wake_second_check_minutes` (0 means off) by button or opening the web.

## 4. Wake-up photo proof

1. **Challenge:** at wake time the bot sends a daily changing random request (hold up N fingers, take a photo at the sink, hold an object). It cannot know whether a photo is fresh, so the challenge makes an old photo useless.
2. **Send:** the user takes a photo inside Telegram or Discord and sends it within `routine.wake_photo_window_minutes`.
3. **Grade:** a vision model checks for a person, open eyes, out of bed and the challenge. Result `pass`, `fail` or `unclear`. `unclear` requests another photo and is never a failure. The grade is a proposal only; the time the accepted photo was sent is the hard fact.
4. **Record:** wake time = the send time of the passing photo. Reply, for example, "Recorded wake at 6:02, on time" or "14 minutes late". At `commit`, being later than the grace period gives fault points with appeal rights.
5. **Privacy:** this photo travels through the chat channel and the LLM provider, so it needs separate consent (`wake_photo`). The server stores only the result and deletes the image after grading; a `fail` photo is kept until the appeal window ends (`routine.retention.failed_wake_photo_hours`), then deleted.
6. **No vision model:** the user picks a separate vision-capable model in settings; without one the flow falls back to a button plus a quick question.
7. The same photo-in-chat mechanism serves other check-ins: offline tasks, meals, exercise.

Limitation shown during onboarding: Do Not Disturb or muted chat can silence the message; the user keeps a phone alarm, and the bot handles what follows: nudging, confirming, logging. Onboarding includes a step to allow the bot to ring during Do Not Disturb.

## 5. Learning and tapering

The weekly review shows estimated bedtime (last web activity), wake time by check-in, meals skipped, and compares them to work performance to suggest adjustments. After `routine.habit_stable_days` of regular behavior the bot reduces reminders and keeps only the wake check-in.

## 6. Events

Published: `routine.reminder_due`, `routine.checkin_recorded`, `routine.late_detected` (only at `commit`), `routine.wake_challenge_sent`, `routine.wake_photo_received`, `routine.wake_graded`, `routine.level_changed`, `routine.block_placed`, `ask.routine_checkin` (question).

Consumed: `ai.photo_graded`, `notify.reply_received` (check-in buttons), `special_mode.*`, `monitor.session_*`, `user.updated`.

## 7. Acceptance

1. Given a routine at `remind`, When the time arrives, Then a message is sent and no check-in or fault exists.
2. Given `wake` at `commit` and an accepted photo 14 minutes after wake time with grace 15 minutes, Then the wake is recorded 14 minutes late and no fault is emitted; at 16 minutes a `routine.late_detected` is emitted with an appealable fault.
3. Given a grade `unclear`, Then another photo is requested and nothing is recorded as failed.
4. Given a passing photo, Then the image is deleted after grading and only the result remains; a failing photo is deleted after the appeal window.
5. Given activity on the web after bedtime, Then one reminder and the `late_night` soft label, with no fault.
6. Given a week with more routine hours than available, Then the plan shows "overloaded" at planning time.
7. Given the user lowers a routine from `commit`, Then the change takes effect from the next week.
