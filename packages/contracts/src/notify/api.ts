import { z } from "zod";
import { ChannelKindSchema, IdSchema, IsoDateTimeSchema, okOrError } from "../common";
import { QuestionSchema, ChannelLinkSchema, OutboundMessageSchema } from "./entities";
import { MessageClassSchema, QuestionStateSchema } from "./enums";

export const SendMessageRequestSchema = OutboundMessageSchema.omit({ id: true, createdAt: true });
export const SendMessageResponseSchema = okOrError(
  z.object({ messageId: IdSchema, deferredToDigest: z.boolean() }),
);

export const CreateQuestionRequestSchema = QuestionSchema.omit({ id: true, state: true, expiresAt: true }).extend({
  questionId: IdSchema,
  expiresAt: IsoDateTimeSchema.optional(),
  subjectRef: z.string().min(1),
});

/** Reply from the web inbox; chat replies arrive through the adapter. Idempotent. */
export const AnswerQuestionRequestSchema = z.object({ questionId: IdSchema, value: z.string().min(1) });
export const AnswerQuestionResponseSchema = okOrError(
  z.object({ state: QuestionStateSchema, accepted: z.boolean() }),
);

export const InboxQuerySchema = z.object({
  service: z.string().optional(),
  state: QuestionStateSchema.optional(),
  class: MessageClassSchema.optional(),
  cursor: z.string().optional(),
  limit: z.number().int().positive().max(100).default(50),
});
export const InboxItemSchema = z.object({
  id: IdSchema,
  class: MessageClassSchema,
  messageKey: z.string(),
  params: z.record(z.union([z.string(), z.number(), z.boolean()])),
  question: QuestionSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export const InboxResponseSchema = okOrError(
  z.object({ items: z.array(InboxItemSchema), nextCursor: z.string().nullable() }),
);

export const LinkChannelRequestSchema = z.object({ channel: ChannelKindSchema });
export const LinkChannelResponseSchema = okOrError(
  z.object({ userToken: z.string().min(1), link: ChannelLinkSchema.nullable() }),
);

export const PushSubscriptionRequestSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
});
