import { z } from "zod";

export const WeekStateSchema = z.enum(["draft", "planned", "active", "reviewing", "closed"]);
export const TaskStateSchema = z.enum([
  "planned",
  "in_progress",
  "done",
  "skipped",
  "carried",
  "cancelled",
]);
export const TaskKindSchema = z.enum(["desk", "offline", "money"]);
export const SessionKindSchema = z.enum(["work", "break", "long_break"]);
export const CalendarKindSchema = z.enum(["solar", "lunar"]);
export const CarryOverRuleSchema = z.enum(["roll_forward", "lower_priority", "ask"]);
export const SpecialModeKindSchema = z.enum(["sick", "travel", "holiday"]);
export const EnergyLevelSchema = z.enum(["low", "medium", "high"]);

export const RoutineLevelSchema = z.enum(["off", "remind", "track", "commit"]);
export type RoutineLevel = z.infer<typeof RoutineLevelSchema>;
export const RoutineKindSchema = z.enum(["sleep", "wake", "meal", "exercise", "custom"]);
export const BlockKindSchema = z.enum(["fixed", "flexible"]);
export const DayProfileSchema = z.enum(["weekday", "weekend"]);

export const SleepNightStateSchema = z.enum([
  "idle",
  "winddown",
  "bedtime_reminded",
  "sleeping",
  "wake_due",
  "awaiting_proof",
  "awake",
  "late",
  "missed",
]);
export const PhotoGradeSchema = z.enum(["pass", "fail", "unclear"]);
export type PhotoGrade = z.infer<typeof PhotoGradeSchema>;
export const CheckinKindSchema = z.enum(["wake", "meal", "exercise", "offline_task_start", "offline_task_end"]);
export const WaiverReasonSchema = z.enum(["special_mode"]);
