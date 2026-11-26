import { z } from "zod";
import {
  IdSchema,
  IsoDateSchema,
  IsoDateTimeSchema,
  TimeOfDaySchema,
} from "../common";
import { MonitoringProfileSchema } from "../monitor/enums";
import {
  BlockKindSchema,
  CalendarKindSchema,
  EnergyLevelSchema,
  RoutineKindSchema,
  RoutineLevelSchema,
  SessionKindSchema,
  SpecialModeKindSchema,
  TaskKindSchema,
  TaskStateSchema,
  WeekStateSchema,
} from "./enums";

export const ScheduleWeekSchema = z.object({
  id: IdSchema,
  firstDay: IsoDateSchema,
  state: WeekStateSchema,
});

export const TaskSchema = z.object({
  id: IdSchema,
  title: z.string().min(1),
  day: IsoDateSchema,
  window: z.object({ start: TimeOfDaySchema, end: TimeOfDaySchema }).nullable(),
  estimatedMinutes: z.number().int().positive(),
  energyLevel: EnergyLevelSchema.nullable(),
  definitionOfDone: z.string().nullable(),
  monitoringProfile: MonitoringProfileSchema,
  kind: TaskKindSchema,
  state: TaskStateSchema,
  carriedCount: z.number().int().nonnegative(),
  parentRecurrenceId: IdSchema.nullable(),
});
export type Task = z.infer<typeof TaskSchema>;

export const SubtaskSchema = z.object({
  id: IdSchema,
  taskId: IdSchema,
  title: z.string().min(1),
  done: z.boolean(),
});

export const WorkSessionSchema = z.object({
  id: IdSchema,
  taskId: IdSchema,
  startedAt: IsoDateTimeSchema,
  endedAt: IsoDateTimeSchema.nullable(),
  kind: SessionKindSchema,
});

export const RecurrencePatternSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("weekly"), weekdays: z.array(z.number().int().min(0).max(6)).min(1) }),
  z.object({ type: z.literal("monthly_day"), day: z.number().int().min(1).max(31) }),
  z.object({
    type: z.literal("lunar_day"),
    day: z.number().int().min(1).max(30),
    month: z.number().int().min(1).max(12).optional(),
  }),
]);
export const RecurrenceSchema = z.object({
  id: IdSchema,
  calendar: CalendarKindSchema,
  pattern: RecurrencePatternSchema,
  exceptions: z.array(IsoDateSchema),
});

export const DailyRhythmEntrySchema = z.object({
  date: IsoDateSchema,
  topPicks: z.array(IdSchema),
  reflection: z.string().nullable(),
});

export const SpecialModePeriodSchema = z.object({
  id: IdSchema,
  kind: SpecialModeKindSchema,
  from: IsoDateTimeSchema,
  to: IsoDateTimeSchema,
  retroactive: z.boolean(),
});

export const RoutineBlockSchema = z.object({
  id: IdSchema,
  routine: RoutineKindSchema,
  level: RoutineLevelSchema,
  blockKind: BlockKindSchema,
  start: TimeOfDaySchema.optional(),
  end: TimeOfDaySchema.optional(),
  windowFrom: TimeOfDaySchema.optional(),
  windowTo: TimeOfDaySchema.optional(),
  durationMinutes: z.number().int().positive().optional(),
});
