import { z } from "zod";
import { AskPayloadSchema } from "../budget/events";
import { IdSchema, IsoDateTimeSchema } from "../common";
import { FaultTypeSchema } from "../rules/enums";
import { ReasonKindSchema, SignalClassSchema, SignalSchema, SupervisionLevelSchema } from "./enums";

const sessionRef = z.object({ sessionId: IdSchema });

export const monitorEvents = {
  "monitor.session_started": sessionRef.extend({ taskId: IdSchema.nullable() }),
  "monitor.session_ended": sessionRef.extend({ endedAt: IsoDateTimeSchema }),
  "focus.signal_detected": z.object({
    sessionId: IdSchema,
    signal: SignalSchema,
    signalClass: SignalClassSchema,
    startedAt: IsoDateTimeSchema,
    confidence: z.number().min(0).max(1),
  }),
  /** Hard signals only. */
  "fault.detected": z.object({
    signalRef: z.string().min(1),
    type: FaultTypeSchema,
    occurredAt: IsoDateTimeSchema,
    reason: z.enum(["none", "given"]),
    reasonRef: IdSchema.nullable(),
    reasonKind: ReasonKindSchema.nullable(),
    overlapsOutage: z.boolean(),
  }),
  "reason.given": z.object({
    ticketId: IdSchema,
    signalRef: z.string().min(1),
    kind: ReasonKindSchema,
    givenAt: IsoDateTimeSchema,
  }),
  "reason.expired": z.object({ ticketId: IdSchema, signalRef: z.string().min(1) }),
  "urgent.sent": z.object({ ticketId: IdSchema, channel: z.enum(["web", "chat"]) }),
  "break.started": sessionRef.extend({ maxMinutes: z.number().int().positive() }),
  "break.ended": sessionRef,
  "supervision.level_changed": z.object({
    from: SupervisionLevelSchema,
    to: SupervisionLevelSchema,
    cause: z.enum(["taper_accepted", "user_stricter", "user_looser", "consent_revoked"]),
    effectiveFrom: IsoDateTimeSchema,
  }),
  "ask.supervision_taper": AskPayloadSchema,
};
