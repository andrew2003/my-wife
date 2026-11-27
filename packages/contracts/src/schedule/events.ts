import { z } from "zod";
import { AskPayloadSchema } from "../budget/events";
import {
  IdSchema,
  IsoDateSchema,
  IsoDateTimeSchema,
  NonNegativeVndSchema,
  TimeOfDaySchema,
} from "../common";
import { FaultTypeSchema } from "../rules/enums";
import {
  CheckinKindSchema,
  PhotoGradeSchema,
  RoutineKindSchema,
  RoutineLevelSchema,
  SpecialModeKindSchema,
} from "./enums";

const weekRef = z.object({ weekId: IdSchema, firstDay: IsoDateSchema });
const taskRef = z.object({ taskId: IdSchema });
const sessionRef = z.object({ sessionId: IdSchema, taskId: IdSchema });

/** One planned expense the user approved with the week; budget issues its transfer code. */
export const WeekPlannedItemSchema = z.object({
  categoryId: IdSchema,
  amountVnd: NonNegativeVndSchema,
});
export type WeekPlannedItem = z.infer<typeof WeekPlannedItemSchema>;

export const scheduleEvents = {
  /** `plannedItems` is optional; budget publishes them into the budget record (ADR 0013). */
  "week.planned": weekRef.extend({ plannedItems: z.array(WeekPlannedItemSchema).optional() }),
  /** Emitted exactly once per week; budget uses it as the shared week boundary. */
  "week.closed": weekRef.extend({ weekIndexInCycle: z.number().int().positive().nullable() }),
  "task.started": taskRef.extend({ startedAt: IsoDateTimeSchema }),
  "task.ended": taskRef.extend({ endedAt: IsoDateTimeSchema }),
  "task.carried": taskRef.extend({ carriedCount: z.number().int().positive(), toDay: IsoDateSchema }),
  "task.overdue": taskRef.extend({ dueDay: IsoDateSchema }),
  "session.started": sessionRef.extend({ startedAt: IsoDateTimeSchema }),
  "session.ended": sessionRef.extend({ endedAt: IsoDateTimeSchema }),
  "rhythm.morning_due": z.object({ date: IsoDateSchema }),
  "rhythm.evening_due": z.object({ date: IsoDateSchema }),
  "special_mode.started": z.object({
    periodId: IdSchema,
    kind: SpecialModeKindSchema,
    from: IsoDateTimeSchema,
    to: IsoDateTimeSchema,
    retroactive: z.boolean(),
  }),
  "special_mode.ended": z.object({ periodId: IdSchema }),
  "ask.carry_over": AskPayloadSchema,
  "review.ready": weekRef,

  "routine.reminder_due": z.object({
    routine: RoutineKindSchema,
    dueAt: IsoDateTimeSchema,
    messageKey: z.string().min(1),
    params: z.record(z.union([z.string(), z.number()])).default({}),
  }),
  "routine.checkin_recorded": z.object({
    kind: CheckinKindSchema,
    at: IsoDateTimeSchema,
    minutesLate: z.number().int().nonnegative(),
  }),
  /** Only at level `commit`, and only after the grace period. */
  "routine.late_detected": z.object({
    routine: RoutineKindSchema,
    faultType: FaultTypeSchema,
    occurredAt: IsoDateTimeSchema,
    minutesLate: z.number().int().positive(),
  }),
  "routine.wake_challenge_sent": z.object({ challengeId: IdSchema, sentAt: IsoDateTimeSchema }),
  "routine.wake_photo_received": z.object({ challengeId: IdSchema, receivedAt: IsoDateTimeSchema }),
  "routine.wake_graded": z.object({
    challengeId: IdSchema,
    grade: PhotoGradeSchema,
    wakeTime: IsoDateTimeSchema.nullable(),
    minutesLate: z.number().int().nonnegative().nullable(),
  }),
  "routine.level_changed": z.object({
    routine: RoutineKindSchema,
    from: RoutineLevelSchema,
    to: RoutineLevelSchema,
    effectiveFrom: IsoDateTimeSchema,
  }),
  "routine.block_placed": z.object({
    blockId: IdSchema,
    routine: RoutineKindSchema,
    day: IsoDateSchema,
    start: TimeOfDaySchema,
    end: TimeOfDaySchema,
  }),
  "ask.routine_checkin": AskPayloadSchema,
};
