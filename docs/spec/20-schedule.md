# Schedule service

Owner: `schedule`. The weekly timetable (`schedule`), tasks, sub-tasks, sessions, templates, recurrences (solar and lunar), the daily rhythm, special modes, and the calendar tab. Routines are a separate layer specified in `22-routines.md`; this service stores their blocks. Focus monitoring is `21-monitor.md`.

## 1. Entities

| Entity | Key fields |
| --- | --- |
| `schedule_week` | `id`, `first_day` (same as the budget week start), `state`, `review` |
| `task` | `id`, `title`, `day`, `window` (start/end), `estimated_minutes`, `energy_level`, `definition_of_done`, `monitoring_profile_id`, `kind` (`desk`/`offline`/`money`), `state`, `carried_count`, `parent_recurrence_id?` |
| `subtask` | `id`, `task_id`, `title`, `done` |
| `session` | `id`, `task_id`, `started_at`, `ended_at`, `kind` (`work`/`break`/`long_break`), pomodoro config used |
| `template` | day or week template (blocks) |
| `recurrence` | `calendar` (`solar`/`lunar`), pattern (weekly, monthly day, lunar day such as 1st or 15th, death anniversary), exceptions |
| `daily_rhythm_entry` | `date`, `top_picks[]` (default 3), `reflection` |
| `special_mode_period` | `kind` (`sick`/`travel`/`holiday`), `from`, `to`, `retroactive` |
| `routine_block` | owned by routines; fixed or flexible block placed by this service |

Monitoring profiles per task: `none`, `checklist_only`, `camera`, `offline_checkin` (see monitor).

## 2. Week state machine

`draft` -> `planned` -> `active` -> `reviewing` -> `closed`.

| From | Trigger | To | Notes |
| --- | --- | --- | --- |
| `draft` | planning conversation at the end of the previous week (job at `schedule.weekly_review_time`), or the user creates the week | `draft` | Bot proposes using the review: tasks often late, estimate errors, most productive hours |
| `draft` | user approves | `planned` | Routine blocks are placed first, then tasks fill the remaining time. If not enough time: show "overloaded week" at planning time |
| `planned` | the first day arrives | `active` | |
| `active` | the last day ends | `reviewing` | Generates the weekly review; emits `week.closed` once |
| `reviewing` | user finishes review or the next week activates | `closed` | |

Placing a task into sleep time needs a separate confirmation and is counted in the weekly review.

## 3. Task state machine

`planned` -> `in_progress` -> `done`; also `skipped`, `carried`, `cancelled`.

| From | Trigger | To |
| --- | --- | --- |
| `planned` | user starts the countdown | `in_progress` (`task.started`) |
| `in_progress` | user ticks done | `done` (`task.ended`; no chat message is sent) |
| `in_progress` | time ends and user stops | `planned` again with remaining time, or `done` |
| `planned` | day ends unfinished | `carried` according to the carry-over rule |

The user ticks tasks off themselves. The bot never sends a "task completed" message.

Carry-over rule (user choice, `schedule.carry_over_rule`): `roll_forward` (move to the next day), `lower_priority` (move and demote), `ask` (ask with buttons). After `schedule.carry_over_max_times` carries the system asks regardless.

## 4. Work sessions and the clock

- Per-second countdown driven by the real clock, with the tick running in a Web Worker so it is not throttled; the camera running keeps the tab from being throttled to once a minute. The end-of-time sound is scheduled with the Web Audio API. A Document Picture-in-Picture window (Chrome, Edge) shows the timer. A server push is the fallback if the tab dies (see `21-monitor.md`).
- Pomodoro lengths are user settings (`schedule.pomodoro_*`). Breaks inside a session are valid and pause monitoring without a fault.
- Continuous work longer than `schedule.long_session_suggest_break_hours` triggers a break suggestion.
- The server records session start/end; the client clock is never trusted for faults.

## 5. Daily rhythm

- Morning at `schedule.morning_pick_time`: the user picks the top `schedule.morning_pick_count` tasks.
- Evening at `schedule.evening_reflection_time`: a two-minute look-back and finalizing the checklist.
- Money chores appear in the checklist automatically: "Transfer money for the new cycle" (when a cycle is `awaiting_funds`), "Pay penalty" (when a penalty is `due`), "Repay debt" (when a payable is due).

## 6. Special modes

Sick, travel and holiday modes pause monitoring and penalties for the period, limited to `schedule.special_mode_days_per_cycle` days per cycle. Sick mode may be applied retroactively for the last `schedule.sick_retroactive_hours` hours with a reason, counted against the same limit. A special mode loosens rules, but it is bounded by the day quota, so it needs no loosening lock; activating it after a fault is retroactive only within the stated window. Events: `special_mode.started`, `special_mode.ended`.

## 7. Recurrence and calendar

Recurrences use the solar or the lunar calendar (death anniversary, 1st and 15th of the lunar month). The lunar conversion uses the Ho Ngoc Duc algorithm in a pure function `solarToLunar`/`lunarToSolar` with a fixture table, including leap months. The calendar tab shows both calendars. Pushing the schedule to Google Calendar is one way and belongs to `sync`.

## 8. Offline tasks

A task with `kind = offline` (meeting, class, exercise) needs no open web app. The user checks in at start and end through chat buttons; an optional challenge photo uses the same mechanism as wake-up (`22-routines.md`, `30-ai.md`). Check-in times are hard facts for monitoring penalties only if the user opts in.

## 9. Templates and onboarding

The default day template (every time editable) is provided in `40-identity-onboarding.md`. Templates exist for student, regular-hours worker, and freelancer. After one to two weeks the weekly review proposes template changes from actual data.

## 10. Weekly review

Includes: tasks completed vs planned, estimate error, carried tasks, late tasks, effective hours, sleep estimate (last web activity), wake time by check-in, skipped meals, supervision outcomes and suspended penalties so far. The review may be written by the LLM; every number comes from code.

## 11. Events

Published: `week.planned`, `week.closed`, `task.started`, `task.ended`, `task.carried`, `task.overdue`, `session.started`, `session.ended`, `rhythm.morning_due`, `rhythm.evening_due`, `special_mode.started`, `special_mode.ended`, `ask.carry_over` (question with buttons), `review.ready`.

Consumed: `cycle.funds_requested`/`cycle.opened` (create money tasks), `penalty.due`/`penalty.paid`, `debt.opened` (payable due date), `user.updated`, `routine.block_placed`.

## 12. Acceptance

1. Given a week with routine blocks totaling more hours than are available, When the user plans, Then the plan shows "overloaded" before approval.
2. Given a task unfinished at day end and `carry_over_rule = roll_forward`, Then it appears the next day with `carried_count = 1`; after `carry_over_max_times` carries the bot asks.
3. Given the lunar recurrence "1st of the lunar month", Then the calendar shows the correct solar date, including a leap month fixture.
4. Given the user ticks a task done, Then `task.ended` is emitted and no chat message is sent.
5. Given a sick day activated for yesterday within 24 hours and under the day quota, Then faults in that period are marked waived with reason `special_mode`.
6. Given the week boundary, Then budget and schedule share the same first day and `week.closed` is emitted exactly once.
