import { z } from "zod";
import { IdSchema, IsoDateTimeSchema, MessageRefSchema, okOrError } from "../common";
import { SettingKeySchema } from "../settings/registry";
import {
  DegradedReasonSchema,
  HandoverStateSchema,
  LlmProviderSchema,
  ModelRoleSchema,
} from "./enums";

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const AiToolCallSchema = z.discriminatedUnion("tool", [
  strict({
    tool: z.literal("record_cash_expense"),
    args: strict({
      amountVnd: z.number().int().positive(),
      categoryId: IdSchema.optional(),
      note: z.string().optional(),
    }),
  }),
  strict({
    tool: z.literal("create_task"),
    args: strict({
      title: z.string().min(1),
      day: z.string().optional(),
      estimatedMinutes: z.number().int().positive().optional(),
    }),
  }),
  strict({
    tool: z.literal("answer_question"),
    args: strict({ questionId: IdSchema, value: z.string().min(1) }),
  }),
  strict({ tool: z.literal("ask_reason"), args: strict({ signalRef: z.string().min(1) }) }),
  strict({
    tool: z.literal("update_setting"),
    args: strict({ key: SettingKeySchema, value: z.unknown() }),
  }),
  strict({
    tool: z.literal("read_status"),
    args: strict({ scope: z.enum(["budget", "schedule", "penalty"]) }),
  }),
  strict({
    tool: z.literal("create_appeal"),
    args: strict({
      subjectKind: z.enum(["fault", "classification", "wake_photo_grade"]),
      subjectId: IdSchema,
      draftText: z.string().min(1),
    }),
  }),
]);
export type AiToolCall = z.infer<typeof AiToolCallSchema>;

/** Tools that always need a confirm button before taking effect. */
export const AI_TOOLS_REQUIRING_CONFIRM = ["update_setting", "create_appeal"] as const;

export const ChatMessageRequestSchema = z.object({
  text: z.string().min(1),
  /** Everything from email or chat is data, never an instruction. */
  untrusted: z.boolean().default(true),
});
export const ChatMessageResponseSchema = okOrError(
  z.object({
    messageId: IdSchema,
    reply: MessageRefSchema.or(z.object({ text: z.string() })),
    pendingConfirmations: z.array(z.object({ confirmId: IdSchema, tool: z.string() })),
    degraded: z.boolean(),
  }),
);

export const SaveLlmKeyRequestSchema = z.object({
  provider: LlmProviderSchema,
  model: z.string().min(1),
  role: ModelRoleSchema,
  apiKey: z.string().min(1),
});
export const GradePhotoRequestSchema = z.object({
  challengeId: IdSchema,
  challengeKey: z.string().min(1),
  imageBase64: z.string().min(1),
});

export const UsageResponseSchema = okOrError(
  z.object({
    day: z.string(),
    tokensUsed: z.number().int().nonnegative(),
    dailyCap: z.number().int().positive(),
  }),
);

export const MemorySchema = z.object({
  id: IdSchema,
  fact: z.string().min(1),
  source: z.enum(["user_answer", "tool_call", "user_edit"]),
  createdAt: IsoDateTimeSchema,
});
export const PersonaSchema = z.object({
  version: z.number().int().positive(),
  voice: z.string(),
  address: z.object({ self: z.string(), user: z.string() }),
  behaviorRules: z.array(z.string()),
  strictness: z.number().int().min(1).max(5),
});

export const HandoverResultSchema = z.object({
  modelRole: ModelRoleSchema,
  state: HandoverStateSchema,
  passRatio: z.number().min(0).max(1),
  failedQuestions: z.array(z.string()),
});
export const DegradedStatusSchema = z.object({
  degraded: z.boolean(),
  reason: DegradedReasonSchema.nullable(),
});
