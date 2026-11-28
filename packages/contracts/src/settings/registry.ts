import { z } from "zod";
import { SurplusTargetSchema } from "../budget/enums";
import {
  ChannelKindSchema,
  IdSchema,
  PercentSchema,
  TimeOfDaySchema,
  TimeRangeSchema,
  WeekdaySchema,
} from "../common";
import { SupervisionLevelSchema } from "../monitor/enums";
import { NeedOverspendModeSchema } from "../rules/enums";
import { PenaltyThresholdSchema } from "../rules/entities";
import { CarryOverRuleSchema, RoutineLevelSchema } from "../schedule/enums";
import { LoginMethodSchema, SettingOwnerSchema, SettingScopeSchema } from "../identity/enums";

/**
 * Every business number is a setting with a default (principle 1). Defaults come from
 * docs/spec/02-defaults.md. Business code reads values through the settings API and must
 * never import these defaults as constants of its own logic.
 */
type Owner = z.infer<typeof SettingOwnerSchema>;
type Scope = z.infer<typeof SettingScopeSchema>;

export interface SettingDefinition<T extends z.ZodTypeAny = z.ZodTypeAny> {
  schema: T;
  default: z.infer<T>;
  scope: Scope;
  owner: Owner;
}

const def = <T extends z.ZodTypeAny>(
  schema: T,
  value: z.infer<T>,
  owner: Owner,
  scope: Scope = "user",
): SettingDefinition<T> => ({ schema, default: value, scope, owner });

const posInt = z.number().int().positive();
const nonNegInt = z.number().int().nonnegative();
const vnd = z.number().int().nonnegative();
const bool = z.boolean();
const idList = z.array(IdSchema);
const weekdayTime = z.object({ weekday: WeekdaySchema, time: TimeOfDaySchema });

export const SETTINGS = {
  // Calendar and cycles
  "calendar.week_start_day": def(WeekdaySchema, "monday", "identity"),
  "calendar.time_zone": def(z.string().min(1), "Asia/Ho_Chi_Minh", "identity"),
  "budget.cycle_weeks": def(posInt, 4, "budget"),
  "budget.weekly_limit_rounding_vnd": def(posInt, 1000, "budget"),
  "budget.tolerance_percent": def(PercentSchema, 5, "budget"),
  "budget.tolerance_min_vnd": def(vnd, 10000, "budget"),
  "budget.unknown_deadline_hours": def(posInt, 24, "budget"),
  "budget.cash_allocation_deadline_hours": def(posInt, 24, "budget"),
  "budget.exceptions_per_cycle": def(nonNegInt, 2, "budget"),
  "budget.surplus_share_savings_percent": def(PercentSchema, 30, "budget"),
  "budget.surplus_share_future_purchases_percent": def(PercentSchema, 20, "budget"),
  "budget.surplus_remainder_target": def(SurplusTargetSchema, "savings", "budget"),
  "budget.not_mine_quota_per_cycle": def(nonNegInt, 3, "budget"),
  "budget.internal_transfer_match_window_minutes": def(posInt, 60, "budget"),
  "budget.balance_reconciliation_weekday": def(WeekdaySchema, "sunday", "budget"),
  "budget.balance_tolerance_vnd": def(vnd, 1000, "budget"),
  "budget.balance_snapshot_stale_days": def(posInt, 7, "budget"),
  "budget.refund_match_window_days": def(posInt, 60, "budget"),
  "budget.subscription_min_occurrences": def(z.number().int().min(2), 3, "budget"),
  "budget.income_ratio_percent": def(z.number().min(0).max(1000), 100, "budget"),
  /** Ordered category ids; empty means "derive from the user's ordered want list". */
  "budget.unclassified_fallback_order": def(idList, [], "budget"),
  "debt.receivable_overdue_reminder_days": def(nonNegInt, 0, "budget"),
  "debt.receivable_write_off_prompt_days": def(nonNegInt, 7, "budget"),
  "debt.group_expense_collect_days": def(nonNegInt, 7, "budget"),
  "fx.rate_provider": def(z.string().min(1), "default", "budget", "admin"),
  "plan.menu_estimate_enabled": def(bool, true, "budget"),

  // Ingest
  "ingest.template_promotion_matches": def(posInt, 5, "ingest"),
  "ingest.template_first_confirmation": def(bool, true, "ingest"),
  "ingest.template_demotion_failures": def(posInt, 1, "ingest"),
  "ingest.max_email_bytes": def(posInt, 1048576, "ingest", "admin"),
  "ingest.forward_confirmation_ttl_hours": def(posInt, 24, "ingest", "admin"),
  "ingest.hold_match_window_hours": def(posInt, 72, "ingest"),
  "ingest.llm_confidence_floor": def(z.number().min(0).max(1), 0.7, "ingest"),

  // Rules, penalties and trial
  "penalty.overspend_percent": def(PercentSchema, 100, "rules"),
  /**
   * Whether a `need` overspend is penalized (owner answer to Q-0001, ADR 0011): default
   * `penalize`, using penalty.overspend_percent; `warn_only` stays available.
   */
  "penalty.need_overspend_mode": def(NeedOverspendModeSchema, "penalize", "rules"),
  "penalty.weekly_cap_vnd": def(vnd, 500000, "rules"),
  "penalty.withdrawal_extra_percent": def(PercentSchema, 20, "rules"),
  /** Ordered category ids; empty means "derive from the user's ordered want list". */
  "penalty.want_deduction_order": def(idList, [], "rules"),
  "penalty.payment_grace_days": def(nonNegInt, 3, "rules"),
  "trial.weeks": def(posInt, 4, "rules"),
  "trial.installments_k": def(posInt, 1, "rules"),
  "trial.final_appeal_hours": def(posInt, 72, "rules"),
  "fault.weight.heartbeat_lost": def(nonNegInt, 3, "rules"),
  "fault.weight.camera_off": def(nonNegInt, 3, "rules"),
  "fault.weight.no_face": def(nonNegInt, 2, "rules"),
  "fault.weight.tab_away": def(nonNegInt, 1, "rules"),
  "fault.weight.wake_late": def(nonNegInt, 2, "rules"),
  "fault.weight.bedtime_missed": def(nonNegInt, 1, "rules"),
  "fault.reason_multiplier_percent.honest": def(z.number().min(0).max(1000), 50, "rules"),
  "fault.reason_multiplier_percent.silent": def(z.number().min(0).max(1000), 100, "rules"),
  "fault.thresholds": def(
    z.array(PenaltyThresholdSchema),
    [
      { points: 6, amountVnd: 20000 },
      { points: 12, amountVnd: 50000 },
      { points: 20, amountVnd: 100000 },
    ],
    "rules",
  ),
  "fault.waivers_per_week": def(nonNegInt, 2, "rules"),
  "fault.clean_week_clears_points": def(bool, true, "rules"),
  "reward.clean_streak_days": def(posInt, 7, "rules"),
  "reward.unlock_amount_vnd": def(vnd, 50000, "rules"),
  "appeal.window_hours": def(posInt, 24, "rules"),
  "reason.supplement_window_hours": def(posInt, 24, "monitor"),
  "reason.quota_per_week": def(nonNegInt, 3, "monitor"),
  "loosening.effective_from": def(z.enum(["next_week", "next_cycle"]), "next_week", "rules"),

  // Schedule and monitor
  "schedule.task_default_minutes": def(posInt, 30, "schedule"),
  "schedule.pomodoro_work_minutes": def(posInt, 25, "schedule"),
  "schedule.pomodoro_break_minutes": def(posInt, 5, "schedule"),
  "schedule.pomodoro_long_break_minutes": def(posInt, 15, "schedule"),
  "schedule.pomodoro_long_break_every": def(posInt, 4, "schedule"),
  "schedule.carry_over_rule": def(CarryOverRuleSchema, "roll_forward", "schedule"),
  "schedule.carry_over_max_times": def(posInt, 3, "schedule"),
  "schedule.weekly_review_time": def(weekdayTime, { weekday: "sunday", time: "20:00" }, "schedule"),
  "schedule.morning_pick_time": def(TimeOfDaySchema, "07:30", "schedule"),
  "schedule.morning_pick_count": def(posInt, 3, "schedule"),
  "schedule.evening_reflection_time": def(TimeOfDaySchema, "21:30", "schedule"),
  "schedule.long_session_suggest_break_hours": def(posInt, 2, "schedule"),
  "schedule.special_mode_days_per_cycle": def(nonNegInt, 5, "schedule"),
  "schedule.sick_retroactive_hours": def(nonNegInt, 24, "schedule"),
  "monitor.heartbeat_interval_seconds": def(posInt, 10, "monitor", "admin"),
  "monitor.heartbeat_missing_seconds": def(posInt, 30, "monitor"),
  "monitor.no_face_seconds": def(posInt, 30, "monitor"),
  "monitor.tab_away_seconds": def(posInt, 60, "monitor"),
  "monitor.camera_fps": def(z.number().int().min(1).max(30), 3, "web"),
  "monitor.ambiguous_confidence_below": def(z.number().min(0).max(1), 0.6, "web"),
  "monitor.break_max_minutes": def(posInt, 10, "monitor"),
  "monitor.breaks_per_day": def(nonNegInt, 6, "monitor"),
  "monitor.urgent_chat_after_seconds": def(posInt, 60, "monitor"),
  "monitor.urgent_silent_fault_after_seconds": def(posInt, 300, "monitor"),
  "monitor.urgent_min_gap_minutes": def(posInt, 5, "monitor"),
  "monitor.outage_gap_margin_seconds": def(nonNegInt, 60, "monitor", "admin"),
  "monitor.supervision_level": def(SupervisionLevelSchema, "full", "monitor"),
  "monitor.taper_clean_weeks": def(posInt, 4, "monitor"),

  // Routines
  "routine.sleep.level": def(RoutineLevelSchema, "track", "schedule"),
  "routine.meals.level": def(RoutineLevelSchema, "track", "schedule"),
  "routine.wake.level": def(RoutineLevelSchema, "remind", "schedule"),
  "routine.sleep.start": def(TimeOfDaySchema, "23:00", "schedule"),
  "routine.wake.time": def(TimeOfDaySchema, "06:00", "schedule"),
  "routine.winddown_lead_minutes": def(posInt, 60, "schedule"),
  "routine.bedtime_lead_minutes": def(posInt, 15, "schedule"),
  "routine.wake_nudge_interval_minutes": def(posInt, 5, "schedule"),
  "routine.wake_nudge_max": def(posInt, 6, "schedule"),
  "routine.wake_grace_minutes": def(nonNegInt, 15, "schedule"),
  "routine.wake_photo_window_minutes": def(posInt, 10, "schedule"),
  /** 0 means off. */
  "routine.wake_second_check_minutes": def(nonNegInt, 0, "schedule"),
  "routine.meal.lunch_window": def(
    TimeRangeSchema.extend({ durationMinutes: posInt }),
    { from: "11:30", to: "13:30", durationMinutes: 30 },
    "schedule",
  ),
  "routine.habit_stable_days": def(posInt, 14, "schedule"),
  "routine.skipped_meals_flag": def(posInt, 3, "schedule"),
  "routine.retention.failed_wake_photo_hours": def(posInt, 24, "ai"),

  // Notifications and AI
  "notify.channel": def(ChannelKindSchema, "telegram", "notify"),
  "notify.quiet_hours": def(TimeRangeSchema, { from: "23:00", to: "06:30" }, "notify"),
  "notify.morning_digest_time": def(TimeOfDaySchema, "07:00", "notify"),
  "notify.evening_digest_time": def(TimeOfDaySchema, "21:30", "notify"),
  "notify.question_expiry_hours": def(posInt, 24, "notify"),
  "notify.delivery_retries": def(nonNegInt, 3, "notify", "admin"),
  "notify.inbox_retention_days": def(posInt, 180, "notify", "admin"),
  "ai.daily_token_cap": def(posInt, 200000, "ai"),
  "ai.persona_strictness": def(z.number().int().min(1).max(5), 3, "ai"),
  "ai.recent_messages_kept": def(posInt, 20, "ai"),
  "ai.summary_trigger_messages": def(posInt, 40, "ai"),
  "ai.fallback_after_failures": def(posInt, 3, "ai"),
  "ai.request_timeout_seconds": def(posInt, 30, "ai", "admin"),
  "ai.handover_pass_ratio": def(z.number().min(0).max(1), 1.0, "ai", "admin"),
  "ai.memory_retrieval_top_k": def(posInt, 5, "ai"),

  // Identity, sync and admin
  "identity.login_method": def(LoginMethodSchema, "google", "identity", "admin"),
  "identity.invitation_ttl_days": def(posInt, 7, "identity", "admin"),
  "identity.magic_link_ttl_minutes": def(posInt, 15, "identity", "admin"),
  "identity.session_ttl_days": def(posInt, 30, "identity", "admin"),
  "identity.max_users": def(posInt, 100, "identity", "admin"),
  "identity.export_ttl_hours": def(posInt, 24, "identity", "admin"),
  "onboarding.show_tour": def(bool, true, "web"),
  "sync.debounce_seconds": def(posInt, 30, "sync", "admin"),
  "sync.sheet_readback_enabled": def(bool, true, "sync"),
  "sync.calendar_horizon_weeks": def(posInt, 4, "sync"),
  "sync.retry_backoff_seconds": def(z.array(posInt).min(1), [30, 120, 600, 3600], "sync", "admin"),
  "admin.audit_retention_days": def(posInt, 730, "admin", "admin"),
  "admin.incident_waiver_default": def(bool, true, "rules", "admin"),
} as const satisfies Record<string, SettingDefinition>;

export type SettingKey = keyof typeof SETTINGS;
export const SETTING_KEYS = Object.keys(SETTINGS) as [SettingKey, ...SettingKey[]];
export const SettingKeySchema = z.enum(SETTING_KEYS);

export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS)[K]["schema"]>;

export function validateSettingValue(
  key: string,
  value: unknown,
): { success: true; data: unknown } | { success: false; error: string } {
  if (!Object.prototype.hasOwnProperty.call(SETTINGS, key)) {
    return { success: false, error: `unknown setting key: ${key}` };
  }
  const result = SETTINGS[key as SettingKey].schema.safeParse(value);
  return result.success
    ? { success: true, data: result.data }
    : { success: false, error: result.error.message };
}
