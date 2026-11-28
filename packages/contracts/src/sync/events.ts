import { z } from "zod";
import { IdSchema } from "../common";
import {
  CellRejectReasonSchema,
  ConflictWinnerSchema,
  ReadbackPauseReasonSchema,
  SheetKindSchema,
  SyncTargetSchema,
} from "./enums";

export const syncEvents = {
  "sync.sheet_created": z.object({ cycleId: IdSchema, spreadsheetRef: z.string().min(1) }),
  "sync.synced": z.object({ target: SyncTargetSchema, entityCount: z.number().int().nonnegative() }),
  "sync.failed": z.object({
    target: SyncTargetSchema,
    attempt: z.number().int().positive(),
    exhausted: z.boolean(),
    code: z.string(),
  }),
  "sync.readback_applied": z.object({ sheet: SheetKindSchema, cellCount: z.number().int().nonnegative() }),
  "sync.readback_reverted": z.object({
    sheet: SheetKindSchema,
    cellCount: z.number().int().nonnegative(),
    reason: CellRejectReasonSchema,
  }),
  "sync.conflict_resolved": z.object({ conflictId: IdSchema, winner: ConflictWinnerSchema }),
  "sync.readback_paused": z.object({ sheet: SheetKindSchema, reason: ReadbackPauseReasonSchema }),
  "sync.link_revoked": z.object({ target: SyncTargetSchema }),
};
