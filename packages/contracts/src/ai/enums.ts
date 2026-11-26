import { z } from "zod";

/** The only tools a model may call. Nothing here moves money, signs, or changes a penalty. */
export const AI_TOOL_NAMES = [
  "record_cash_expense",
  "create_task",
  "answer_question",
  "ask_reason",
  "update_setting",
  "read_status",
  "create_appeal",
] as const;
export const AiToolNameSchema = z.enum(AI_TOOL_NAMES);
export type AiToolName = z.infer<typeof AiToolNameSchema>;

export const ModelRoleSchema = z.enum(["primary", "fallback", "classifier", "chat", "vision"]);
export type ModelRole = z.infer<typeof ModelRoleSchema>;
export const LlmProviderSchema = z.enum(["anthropic", "openai", "google", "openrouter", "other"]);
export const HandoverStateSchema = z.enum(["pending", "passed", "failed"]);
export const DegradedReasonSchema = z.enum(["no_credit", "key_invalid", "provider_down", "token_cap"]);
