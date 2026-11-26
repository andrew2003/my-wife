import { z } from "zod";
import { IdSchema, IsoDateSchema, IsoDateTimeSchema, okOrError } from "../common";
import {
  DailyRhythmEntrySchema,
  RoutineBlockSchema,
  ScheduleWeekSchema,
  SpecialModePeriodSchema,
  TaskSchema,
} from "./entities";
import { CheckinKindSchema, PhotoGradeSchema, RoutineLevelSchema, SpecialModeKindSchema } from "./enums";

export const CreateTaskRequestSchema = TaskSchema.omit({
  id: true,
  state: true,
  carriedCount: true,
}).partial({ window: true, energyLevel: true, definitionOfDone: true, parentRecurrenceId: true, estimatedMinutes: true });
export const CreateTaskResponseSchema = okOrError(z.object({ task: TaskSchema }));

export const StartTaskRequestSchema = z.object({ taskId: IdSchema });
/** Ticking done never triggers a chat message. */
export const CompleteTaskRequestSchema = z.object({ taskId: IdSchema });

export const PlanWeekResponseSchema = okOrError(
  z.object({
    week: ScheduleWeekSchema,
    overloaded: z.boolean(),
    overloadMinutes: z.number().int().nonnegative(),
  }),
);

export const PickTopTasksRequestSchema = z.object({ date: IsoDateSchema, taskIds: z.array(IdSchema) });
export const RhythmResponseSchema = okOrError(z.object({ entry: DailyRhythmEntrySchema }));

export const StartSpecialModeRequestSchema = z.object({
  kind: SpecialModeKindSchema,
  from: IsoDateTimeSchema,
  to: IsoDateTimeSchema,
  reasonText: z.string().optional(),
});
export const StartSpecialModeResponseSchema = okOrError(
  z.object({ period: SpecialModePeriodSchema, daysUsedInCycle: z.number().int().nonnegative() }),
);

export const SetRoutineLevelRequestSchema = z.object({
  block: RoutineBlockSchema.pick({ routine: true }),
  level: RoutineLevelSchema,
});
export const SetRoutineLevelResponseSchema = okOrError(
  z.object({ level: RoutineLevelSchema, effectiveFrom: IsoDateTimeSchema }),
);

export const RecordCheckinRequestSchema = z.object({
  kind: CheckinKindSchema,
  taskId: IdSchema.optional(),
  /** The send time of the check-in is the hard fact; never the client clock. */
  channelMessageId: z.string().optional(),
});

export const WakeChallengeSchema = z.object({
  challengeId: IdSchema,
  messageKey: z.string().min(1),
  params: z.record(z.union([z.string(), z.number()])),
  expiresAt: IsoDateTimeSchema,
});
export const WakeGradeResultSchema = z.object({
  challengeId: IdSchema,
  grade: PhotoGradeSchema,
  gradedAt: IsoDateTimeSchema,
});

export const SolarLunarConversionRequestSchema = z.object({
  solar: IsoDateSchema.optional(),
  lunar: z.object({ year: z.number().int(), month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(30), leap: z.boolean() }).optional(),
});
