import { z } from "zod";

export const SyncLinkStateSchema = z.enum([
  "unlinked",
  "linking",
  "ready",
  "syncing",
  "error",
  "revoked",
]);
export const SyncTargetSchema = z.enum(["sheets", "calendar"]);

/** Calendar choice in settings: either, both or none (ADR 0015). */
export const CalendarProviderSchema = z.enum(["google", "apple"]);
export type CalendarProvider = z.infer<typeof CalendarProviderSchema>;

export const SheetKindSchema = z.enum(["timetable", "budget"]);
export type SheetKind = z.infer<typeof SheetKindSchema>;

/** Why a cell edit or read-back value was not applied. */
export const CellRejectReasonSchema = z.enum([
  "locked_cell",
  "past_week",
  "validation_failed",
  "booked_fact",
  "readback_disabled",
]);
export type CellRejectReason = z.infer<typeof CellRejectReasonSchema>;

export const ConflictWinnerSchema = z.enum(["app", "sheet"]);
export type ConflictWinner = z.infer<typeof ConflictWinnerSchema>;

export const ReadbackPauseReasonSchema = z.enum(["malformed_sheet", "structure_changed"]);
export type ReadbackPauseReason = z.infer<typeof ReadbackPauseReasonSchema>;
