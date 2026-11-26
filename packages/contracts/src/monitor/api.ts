import { z } from "zod";
import { ApiErrorSchema, IdSchema, IsoDateTimeSchema } from "../common";
import {
  MonitoringProfileSchema,
  MonitorErrorCodeSchema,
  ReasonKindSchema,
  SignalSchema,
} from "./enums";

export const MonitorStartSessionRequestSchema = z.object({
  taskId: IdSchema.nullable(),
  profile: MonitoringProfileSchema,
  deviceId: z.string().min(1),
});
export const MonitorStartSessionResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: z.object({ sessionId: IdSchema, startedAt: IsoDateTimeSchema }) }),
  z.object({
    ok: z.literal(false),
    error: ApiErrorSchema.extend({ code: MonitorErrorCodeSchema }),
  }),
]);

/** Heartbeat carries filtered events only: type, timestamps, confidence. Never an image. */
export const FocusEventSchema = z
  .object({
    type: SignalSchema,
    startedAt: IsoDateTimeSchema,
    endedAt: IsoDateTimeSchema.optional(),
    confidence: z.number().min(0).max(1),
  })
  .strict();
export const HeartbeatRequestSchema = z
  .object({
    sessionId: IdSchema,
    sentAt: IsoDateTimeSchema,
    events: z.array(FocusEventSchema).default([]),
  })
  .strict();

export const GiveReasonRequestSchema = z.object({
  ticketId: IdSchema,
  kind: ReasonKindSchema,
  text: z.string().max(500).optional(),
});
export const StartBreakRequestSchema = z.object({ sessionId: IdSchema });

/** Single frame, only for an appeal or an ambiguous result, with consent `vision_frame`. */
export const AppealFrameRequestSchema = z.object({
  appealId: IdSchema,
  frameBase64: z.string().min(1),
});
