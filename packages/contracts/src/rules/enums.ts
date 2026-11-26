import { z } from "zod";

export const HardSignalSchema = z.enum([
  "heartbeat_lost",
  "camera_off",
  "no_face",
  "tab_away",
]);
export const RoutineFaultTypeSchema = z.enum(["wake_late", "bedtime_missed"]);
/** Only hard signals produce fault types; soft signals never do. */
export const FaultTypeSchema = z.enum([
  ...HardSignalSchema.options,
  ...RoutineFaultTypeSchema.options,
]);
export type FaultType = z.infer<typeof FaultTypeSchema>;

export const FaultReasonKindSchema = z.enum(["none", "honest", "quota_exceeded"]);
export const FaultStatusSchema = z.enum([
  "pending_reason",
  "recorded",
  "appealed",
  "upheld",
  "overturned",
  "waived_system",
  "waived_card",
  "expired",
]);
export type FaultStatus = z.infer<typeof FaultStatusSchema>;

export const WaiverCauseSchema = z.enum([
  "admin_incident",
  "heartbeat_gap_outage",
  "misread",
  "special_mode",
  "appeal",
]);

export const PenaltySourceSchema = z.enum(["overspend", "monitoring", "routine", "withdrawal"]);
export const PenaltyStatusSchema = z.enum(["suspended", "due", "paid"]);
export type PenaltyStatus = z.infer<typeof PenaltyStatusSchema>;

export const AppealStatusSchema = z.enum(["open", "upheld", "overturned"]);
export const AppealOutcomeSchema = z.enum(["upheld", "overturned"]);

export const TrialStateSchema = z.enum(["off", "active", "final_appeal", "settled"]);

export const NeedOverspendModeSchema = z.enum(["warn_only", "penalize"]);
export const RuleChangeDirectionSchema = z.enum(["tightening", "loosening"]);
