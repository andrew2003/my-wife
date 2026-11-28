import { z } from "zod";
import { IdSchema, IsoDateTimeSchema, okOrError } from "../common";
import {
  CellRejectReasonSchema,
  ConflictWinnerSchema,
  SheetKindSchema,
  SyncLinkStateSchema,
  SyncTargetSchema,
} from "./enums";

export const StartLinkRequestSchema = z.object({ target: SyncTargetSchema });
export const StartLinkResponseSchema = okOrError(z.object({ authorizationUrl: z.string().url() }));
export const SyncStatusResponseSchema = okOrError(
  z.object({
    links: z.array(
      z.object({
        target: SyncTargetSchema,
        state: SyncLinkStateSchema,
        lastSyncedAt: IsoDateTimeSchema.nullable(),
        maskTitles: z.boolean(),
      }),
    ),
  }),
);
export const SetMaskTitlesRequestSchema = z.object({ mask: z.boolean() });

/** Scalar cell value. Sheet text is untrusted data and is never an instruction. */
export const CellValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/** An edit of one editable cell, from the in-app sheet view or read back from Google Sheets. */
export const CellEditRequestSchema = z.object({
  sheet: SheetKindSchema,
  tab: z.string().min(1),
  cellRef: z.string().min(1),
  entityId: IdSchema.optional(),
  field: z.string().min(1),
  value: CellValueSchema,
});
export const CellEditResponseSchema = okOrError(
  z.object({
    status: z.enum(["applied", "rejected"]),
    reason: CellRejectReasonSchema.optional(),
  }),
);

/** Audit record of a per-cell conflict resolved by last write; both values are kept. */
export const ReadbackConflictRecordSchema = z.object({
  id: IdSchema,
  sheet: SheetKindSchema,
  tab: z.string().min(1),
  cellRef: z.string().min(1),
  field: z.string().min(1),
  appValue: CellValueSchema,
  sheetValue: CellValueSchema,
  appChangedAt: IsoDateTimeSchema,
  sheetChangedAt: IsoDateTimeSchema,
  winner: ConflictWinnerSchema,
  resolvedAt: IsoDateTimeSchema,
});
