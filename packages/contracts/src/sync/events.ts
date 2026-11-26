import { z } from "zod";
import { IdSchema } from "../common";
import { SyncTargetSchema } from "./enums";

export const syncEvents = {
  "sync.sheet_created": z.object({ cycleId: IdSchema, spreadsheetRef: z.string().min(1) }),
  "sync.synced": z.object({ target: SyncTargetSchema, entityCount: z.number().int().nonnegative() }),
  "sync.failed": z.object({
    target: SyncTargetSchema,
    attempt: z.number().int().positive(),
    exhausted: z.boolean(),
    code: z.string(),
  }),
  "sync.link_revoked": z.object({ target: SyncTargetSchema }),
};
