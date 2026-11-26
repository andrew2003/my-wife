import { z } from "zod";
import { ChannelKindSchema, IdSchema, IsoDateTimeSchema } from "../common";
import { DeliveryChannelSchema, DigestKindSchema, MessageClassSchema } from "./enums";

export const notifyEvents = {
  "notify.sent": z.object({
    messageId: IdSchema,
    class: MessageClassSchema,
    channel: DeliveryChannelSchema,
  }),
  "notify.delivery_failed": z.object({
    messageId: IdSchema,
    channel: DeliveryChannelSchema,
    attempts: z.number().int().positive(),
  }),
  "notify.reply_received": z.object({
    questionId: IdSchema,
    sourceService: z.string(),
    kind: z.string(),
    value: z.string(),
    answeredAt: IsoDateTimeSchema,
    via: z.enum(["chat", "web"]),
  }),
  "notify.question_expired": z.object({
    questionId: IdSchema,
    sourceService: z.string(),
    kind: z.string(),
  }),
  "channel.linked": z.object({ channel: ChannelKindSchema }),
  "channel.unhealthy": z.object({ channel: ChannelKindSchema, detail: z.string().optional() }),
  "digest.sent": z.object({ digest: DigestKindSchema, itemCount: z.number().int().nonnegative() }),
};
