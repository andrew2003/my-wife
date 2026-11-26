import { z } from "zod";
import { HardSignalSchema } from "../rules/enums";

export { HardSignalSchema };
export const SoftSignalSchema = z.enum(["looking_away", "head_down", "yawn", "drowsy", "late_night"]);
export const SignalSchema = z.enum([...HardSignalSchema.options, ...SoftSignalSchema.options]);
export type Signal = z.infer<typeof SignalSchema>;
export const SignalClassSchema = z.enum(["hard", "soft"]);

export const ReasonTicketStateSchema = z.enum([
  "open",
  "answered",
  "escalated",
  "expired",
  "closed",
]);
export const ReasonKindSchema = z.enum([
  "restroom",
  "water",
  "urgent_task",
  "network_problem",
  "device_problem",
  "interruption",
  "other",
]);
export const SupervisionLevelSchema = z.enum(["full", "no_camera", "checklist_only", "graduated"]);
export type SupervisionLevel = z.infer<typeof SupervisionLevelSchema>;
export const MonitoringProfileSchema = z.enum(["none", "checklist_only", "camera", "offline_checkin"]);
export const MonitorErrorCodeSchema = z.enum([
  "session.already_active",
  "consent.camera_required",
  "monitoring.not_in_window",
  "break.quota_exceeded",
]);
