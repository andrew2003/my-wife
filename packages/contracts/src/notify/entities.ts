import { z } from "zod";
import {
  ChannelKindSchema,
  IdSchema,
  IsoDateTimeSchema,
  MessageRefSchema,
  LocaleSchema,
  ServiceNameSchema,
} from "../common";
import { MessageClassSchema, QuestionKindSchema, QuestionStateSchema } from "./enums";

export const QuestionOptionSchema = z.object({
  /** Stable value; owners match on it, never on display text. */
  value: z.string().min(1),
  labelKey: z.string().min(1),
});

export const QuestionSchema = z.object({
  id: IdSchema,
  sourceService: ServiceNameSchema,
  kind: QuestionKindSchema,
  options: z.array(QuestionOptionSchema).min(1),
  expiresAt: IsoDateTimeSchema,
  state: QuestionStateSchema,
});
export type Question = z.infer<typeof QuestionSchema>;

export const OutboundMessageSchema = z.object({
  id: IdSchema,
  class: MessageClassSchema,
  message: MessageRefSchema,
  locale: LocaleSchema,
  sourceService: ServiceNameSchema,
  /** Marks the wake-up message, the only non-urgent one allowed in quiet hours. */
  isWakeUp: z.boolean().default(false),
  createdAt: IsoDateTimeSchema,
});
export type OutboundMessage = z.infer<typeof OutboundMessageSchema>;

export const ChannelLinkSchema = z.object({
  id: IdSchema,
  channel: ChannelKindSchema,
  externalId: z.string().min(1),
  linkedAt: IsoDateTimeSchema,
});

/** Neutral shapes the adapter returns; business code never sees grammY or discord.js types. */
export const InboundReplySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("button"),
    questionId: IdSchema,
    value: z.string(),
    externalId: z.string(),
    sentAt: IsoDateTimeSchema,
  }),
  z.object({
    kind: z.literal("text"),
    text: z.string(),
    externalId: z.string(),
    sentAt: IsoDateTimeSchema,
  }),
  z.object({
    kind: z.literal("photo"),
    challengeId: IdSchema.nullable(),
    fileRef: z.string(),
    externalId: z.string(),
    sentAt: IsoDateTimeSchema,
  }),
]);
export type InboundReply = z.infer<typeof InboundReplySchema>;

export const SendResultSchema = z.object({
  externalMessageId: z.string(),
  acceptedAt: IsoDateTimeSchema,
});
export type SendResult = z.infer<typeof SendResultSchema>;
