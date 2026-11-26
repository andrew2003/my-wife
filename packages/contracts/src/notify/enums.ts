import { z } from "zod";

export const MessageClassSchema = z.enum(["urgent", "timed", "question", "digest"]);
export type MessageClass = z.infer<typeof MessageClassSchema>;
export const QuestionStateSchema = z.enum([
  "created",
  "delivered",
  "delivered_inbox_only",
  "answered",
  "expired",
  "cancelled",
]);
export type QuestionState = z.infer<typeof QuestionStateSchema>;
export const DeliveryChannelSchema = z.enum(["telegram", "discord", "web_push", "inbox"]);
export const DigestKindSchema = z.enum(["morning", "evening"]);
export const ChannelHealthSchema = z.enum(["healthy", "unhealthy"]);
export const QuestionKindSchema = z.enum([
  "budget_category",
  "routine_checkin",
  "carry_over",
  "supervision_taper",
  "other",
]);
