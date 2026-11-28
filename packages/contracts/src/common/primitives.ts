import { z } from "zod";

/** Opaque identifier (UUID or ULID, chosen by the owning service). */
export const IdSchema = z.string().min(1);
export type Id = z.infer<typeof IdSchema>;

/** Money is an integer number of VND (ADR 0008). */
export const VndAmountSchema = z.number().int().safe();
export type VndAmount = z.infer<typeof VndAmountSchema>;
export const NonNegativeVndSchema = VndAmountSchema.nonnegative();

/** UTC instant, ISO 8601 with a trailing Z (ADR 0008). */
export const IsoDateTimeSchema = z.string().datetime();
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;

/** Calendar date in the user's time zone, `YYYY-MM-DD`. */
export const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export type IsoDate = z.infer<typeof IsoDateSchema>;

/** Local time of day, `HH:MM`. */
export const TimeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export type TimeOfDay = z.infer<typeof TimeOfDaySchema>;

export const TimeRangeSchema = z.object({ from: TimeOfDaySchema, to: TimeOfDaySchema });
export type TimeRange = z.infer<typeof TimeRangeSchema>;

export const PercentSchema = z.number().min(0).max(100);

export const LocaleSchema = z.enum(["vi", "en"]);
export type Locale = z.infer<typeof LocaleSchema>;

export const WeekdaySchema = z.enum([
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]);
export type Weekday = z.infer<typeof WeekdaySchema>;

/** User-facing text is a key plus parameters, rendered from locale files (ADR 0009). */
export const MessageRefSchema = z.object({
  key: z.string().min(1),
  params: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
});
export type MessageRef = z.infer<typeof MessageRefSchema>;

export const SERVICE_NAMES = [
  "gateway",
  "identity",
  "budget",
  "ingest",
  "schedule",
  "monitor",
  "rules",
  "ai",
  "notify",
  "sync",
] as const;
export const ServiceNameSchema = z.enum(SERVICE_NAMES);
export type ServiceName = z.infer<typeof ServiceNameSchema>;

export const PrioritySchema = z.enum(["need", "should", "want", "fund"]);
export type Priority = z.infer<typeof PrioritySchema>;

export const ConsentKindSchema = z.enum([
  "camera",
  "vision_frame",
  "wake_photo",
  "email",
  "bank",
  "google_sync",
  "apple_calendar_sync",
]);
export type ConsentKind = z.infer<typeof ConsentKindSchema>;
export const CONSENT_KINDS = ConsentKindSchema.options;

export const ChannelKindSchema = z.enum(["telegram", "discord"]);
export type ChannelKind = z.infer<typeof ChannelKindSchema>;

/** Standard error body for every REST API. */
export const ApiErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().optional(),
  details: z.record(z.unknown()).optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const okOrError = <T extends z.ZodTypeAny>(data: T) =>
  z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), data }),
    z.object({ ok: z.literal(false), error: ApiErrorSchema }),
  ]);

export const AppealableSubjectSchema = z.enum([
  "fault",
  "classification",
  "wake_photo_grade",
  "trial_summary",
]);
export type AppealableSubject = z.infer<typeof AppealableSubjectSchema>;
