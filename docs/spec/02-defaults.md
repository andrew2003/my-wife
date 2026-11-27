# Defaults

This is the single table of every number in the domain specs. Each row is a **user-configurable setting** with a default (principle 1). No business code may hard-code these values; code reads the setting through the identity service settings API (or the owning service's settings store) and takes time as a parameter. Where `docs/spec/00-final-decisions.md` or the source gives a number, it is used. Where they only say "N", "X" or "K", the default below was chosen by the architect and logged in `docs/decisions.md`.

Conventions: `key` is `<domain>.<name>` in `snake_case`. Money is integer VND. Durations carry their unit in the name. "Scope" says who may change it: `user` (each user), `admin` (platform-wide, see `50-admin.md`).

## Calendar and cycles

| Key | Default | Scope | Used by |
| --- | --- | --- | --- |
| `calendar.week_start_day` | `monday` | user | budget, schedule (shared first day) |
| `calendar.time_zone` | `Asia/Ho_Chi_Minh` | user | all (display and job scheduling) |
| `budget.cycle_weeks` | 4 | user | budget |
| `budget.weekly_limit_rounding_vnd` | 1000 | user | budget |
| `budget.tolerance_percent` | 5 | user | budget (reconciliation) |
| `budget.tolerance_min_vnd` | 10000 | user | budget (reconciliation) |
| `budget.unknown_deadline_hours` | 24 | user | budget |
| `budget.cash_allocation_deadline_hours` | 24 | user | budget |
| `budget.exceptions_per_cycle` | 2 | user | budget (contingency fund draws) |
| `budget.surplus_share_savings_percent` | 30 | user | budget |
| `budget.surplus_share_future_purchases_percent` | 20 | user | budget |
| `budget.surplus_remainder_target` | `savings` | user | budget (where the remaining share goes) |
| `budget.not_mine_quota_per_cycle` | 3 | user | budget ("not mine" button) |
| `budget.internal_transfer_match_window_minutes` | 60 | user | budget |
| `budget.balance_reconciliation_weekday` | `sunday` | user | budget |
| `budget.balance_tolerance_vnd` | 1000 | user | budget |
| `budget.balance_snapshot_stale_days` | 7 | user | budget |
| `budget.refund_match_window_days` | 60 | user | budget |
| `budget.subscription_min_occurrences` | 3 | user | budget |
| `budget.income_ratio_percent` | 100 | user | budget (suggested budget = last income pool x ratio) |
| `budget.unclassified_fallback_order` | user's ordered `want` list | user | budget |
| `debt.receivable_overdue_reminder_days` | 0 | user | budget (remind on the due date) |
| `debt.receivable_write_off_prompt_days` | 7 | user | budget (X days after due date) |
| `debt.group_expense_collect_days` | 7 | user | budget |
| `fx.rate_provider` | `default` | admin | budget (pluggable) |
| `plan.menu_estimate_enabled` | true | user | budget |

## Ingest

| Key | Default | Scope | Used by |
| --- | --- | --- | --- |
| `ingest.template_promotion_matches` | 5 | user | ingest (N consecutive matches to `trusted`) |
| `ingest.template_first_confirmation` | true | user | ingest |
| `ingest.template_demotion_failures` | 1 | user | ingest (consecutive parser failures to demote) |
| `ingest.max_email_bytes` | 1048576 | admin | ingest |
| `ingest.forward_confirmation_ttl_hours` | 24 | admin | ingest |
| `ingest.hold_match_window_hours` | 72 | user | ingest (pair an FX authorization with its debit) |
| `ingest.llm_confidence_floor` | 0.7 | user | ingest |

## Rules, penalties and trial

| Key | Default | Scope | Used by |
| --- | --- | --- | --- |
| `penalty.overspend_percent` | 100 | user | rules |
| `penalty.need_overspend_mode` | `penalize` (alternative `warn_only`) | user | rules |
| `penalty.weekly_cap_vnd` | 500000 | user | rules |
| `penalty.withdrawal_extra_percent` | 20 | user | rules |
| `penalty.want_deduction_order` | user's ordered `want` list | user | rules |
| `penalty.payment_grace_days` | 3 | user | rules (before `penalty_unpaid` shows) |
| `trial.weeks` | 4 | user | rules |
| `trial.installments_k` | 1 | user | rules (fixed when trial is enabled) |
| `trial.final_appeal_hours` | 72 | user | rules |
| `fault.weight.heartbeat_lost` | 3 | user | rules |
| `fault.weight.camera_off` | 3 | user | rules |
| `fault.weight.no_face` | 2 | user | rules |
| `fault.weight.tab_away` | 1 | user | rules |
| `fault.weight.wake_late` | 2 | user | rules (routine `commit` level) |
| `fault.weight.bedtime_missed` | 1 | user | rules (routine `commit` level) |
| `fault.reason_multiplier_percent.honest` | 50 | user | rules |
| `fault.reason_multiplier_percent.silent` | 100 | user | rules |
| `fault.thresholds` | `[{points: 6, amount_vnd: 20000}, {points: 12, amount_vnd: 50000}, {points: 20, amount_vnd: 100000}]` | user | rules (weekly) |
| `fault.waivers_per_week` | 2 | user | rules |
| `fault.clean_week_clears_points` | true | user | rules |
| `reward.clean_streak_days` | 7 | user | rules |
| `reward.unlock_amount_vnd` | 50000 | user | rules |
| `appeal.window_hours` | 24 | user | rules |
| `reason.supplement_window_hours` | 24 | user | monitor |
| `reason.quota_per_week` | 3 | user | monitor (per reason type) |
| `loosening.effective_from` | `next_week` | user | rules (`next_cycle` for budget rules) |

## Schedule and monitor

| Key | Default | Scope | Used by |
| --- | --- | --- | --- |
| `schedule.task_default_minutes` | 30 | user | schedule |
| `schedule.pomodoro_work_minutes` | 25 | user | schedule |
| `schedule.pomodoro_break_minutes` | 5 | user | schedule |
| `schedule.pomodoro_long_break_minutes` | 15 | user | schedule |
| `schedule.pomodoro_long_break_every` | 4 | user | schedule |
| `schedule.carry_over_rule` | `roll_forward` | user | schedule |
| `schedule.carry_over_max_times` | 3 | user | schedule (then ask) |
| `schedule.weekly_review_time` | `sun 20:00` | user | schedule |
| `schedule.morning_pick_time` | `07:30` | user | schedule |
| `schedule.morning_pick_count` | 3 | user | schedule |
| `schedule.evening_reflection_time` | `21:30` | user | schedule |
| `schedule.long_session_suggest_break_hours` | 2 | user | schedule |
| `schedule.special_mode_days_per_cycle` | 5 | user | schedule (sick, travel, holiday) |
| `schedule.sick_retroactive_hours` | 24 | user | schedule |
| `monitor.heartbeat_interval_seconds` | 10 | admin | monitor |
| `monitor.heartbeat_missing_seconds` | 30 | user | monitor |
| `monitor.no_face_seconds` | 30 | user | monitor |
| `monitor.tab_away_seconds` | 60 | user | monitor |
| `monitor.camera_fps` | 3 | user | web |
| `monitor.ambiguous_confidence_below` | 0.6 | user | web |
| `monitor.break_max_minutes` | 10 | user | monitor |
| `monitor.breaks_per_day` | 6 | user | monitor |
| `monitor.urgent_chat_after_seconds` | 60 | user | monitor |
| `monitor.urgent_silent_fault_after_seconds` | 300 | user | monitor |
| `monitor.urgent_min_gap_minutes` | 5 | user | monitor, notify |
| `monitor.outage_gap_margin_seconds` | 60 | admin | monitor |
| `monitor.supervision_level` | `full` | user | monitor |
| `monitor.taper_clean_weeks` | 4 | user | monitor (clean weeks per level step) |

## Routines

| Key | Default | Scope | Used by |
| --- | --- | --- | --- |
| `routine.sleep.level` | `track` | user | schedule |
| `routine.meals.level` | `track` | user | schedule |
| `routine.wake.level` | `remind` | user | schedule (user opts into `commit`) |
| `routine.sleep.start` | `23:00` | user | schedule |
| `routine.wake.time` | `06:00` | user | schedule |
| `routine.winddown_lead_minutes` | 60 | user | schedule |
| `routine.bedtime_lead_minutes` | 15 | user | schedule |
| `routine.wake_nudge_interval_minutes` | 5 | user | schedule |
| `routine.wake_nudge_max` | 6 | user | schedule |
| `routine.wake_grace_minutes` | 15 | user | schedule |
| `routine.wake_photo_window_minutes` | 10 | user | schedule |
| `routine.wake_second_check_minutes` | 0 (off) | user | schedule |
| `routine.meal.lunch_window` | `11:30-13:30`, 30 min | user | schedule |
| `routine.habit_stable_days` | 14 | user | schedule (then reduce reminders) |
| `routine.skipped_meals_flag` | 3 per week | user | schedule (weekly review flag) |
| `routine.retention.failed_wake_photo_hours` | 24 (the appeal window) | user | ai |

## Notifications and AI

| Key | Default | Scope | Used by |
| --- | --- | --- | --- |
| `notify.channel` | `telegram` | user | notify |
| `notify.quiet_hours` | `{from: "23:00", to: "06:30"}` | user | notify |
| `notify.morning_digest_time` | `07:00` | user | notify |
| `notify.evening_digest_time` | `21:30` | user | notify |
| `notify.question_expiry_hours` | 24 | user | notify |
| `notify.delivery_retries` | 3 | admin | notify |
| `notify.inbox_retention_days` | 180 | admin | notify |
| `ai.daily_token_cap` | 200000 | user | ai |
| `ai.persona_strictness` | 3 (scale 1 to 5) | user | ai |
| `ai.recent_messages_kept` | 20 | user | ai |
| `ai.summary_trigger_messages` | 40 | user | ai |
| `ai.fallback_after_failures` | 3 | user | ai |
| `ai.request_timeout_seconds` | 30 | admin | ai |
| `ai.handover_pass_ratio` | 1.0 | admin | ai |
| `ai.memory_retrieval_top_k` | 5 | user | ai |

## Identity, sync and admin

| Key | Default | Scope | Used by |
| --- | --- | --- | --- |
| `identity.login_method` | `google` (from `LOGIN_METHOD`) | admin | identity |
| `identity.invitation_ttl_days` | 7 | admin | identity |
| `identity.magic_link_ttl_minutes` | 15 | admin | identity |
| `identity.session_ttl_days` | 30 | admin | identity |
| `identity.max_users` | 100 | admin | identity |
| `identity.export_ttl_hours` | 24 | admin | identity |
| `onboarding.show_tour` | true | user | web |
| `sync.debounce_seconds` | 30 | admin | sync |
| `sync.calendar_horizon_weeks` | 4 | user | sync |
| `sync.retry_backoff_seconds` | `[30, 120, 600, 3600]` | admin | sync |
| `admin.audit_retention_days` | 730 | admin | admin |
| `admin.incident_waiver_default` | true | admin | rules |
