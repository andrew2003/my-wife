import { z } from "zod";
import { IdSchema, IsoDateTimeSchema } from "../common";
import { PhotoGradeSchema } from "../schedule/enums";
import { DegradedReasonSchema, ModelRoleSchema } from "./enums";

export const aiEvents = {
  "ai.message_sent": z.object({ messageId: IdSchema, toolCalls: z.number().int().nonnegative() }),
  /** The grade is a proposal only; the time the accepted photo was sent is the hard fact. */
  "ai.photo_graded": z.object({
    challengeId: IdSchema,
    grade: PhotoGradeSchema,
    gradedAt: IsoDateTimeSchema,
  }),
  "ai.model_changed": z.object({ role: ModelRoleSchema, provider: z.string(), model: z.string() }),
  "ai.handover_passed": z.object({ role: ModelRoleSchema, passRatio: z.number().min(0).max(1) }),
  "ai.handover_failed": z.object({
    role: ModelRoleSchema,
    passRatio: z.number().min(0).max(1),
    failedQuestions: z.array(z.string()),
  }),
  "ai.degraded_entered": z.object({ reason: DegradedReasonSchema }),
  "ai.degraded_exited": z.object({}),
  "ai.token_cap_reached": z.object({ day: z.string(), cap: z.number().int().positive() }),
  "memory.created": z.object({ memoryId: IdSchema }),
  "memory.updated": z.object({ memoryId: IdSchema }),
  "memory.deleted": z.object({ memoryId: IdSchema }),
  "persona.updated": z.object({ version: z.number().int().positive() }),
  "ai.template_read_result": z.object({
    receiptId: IdSchema,
    fields: z.record(z.unknown()).nullable(),
    confidence: z.number().min(0).max(1),
  }),
};
