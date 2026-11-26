import { z } from "zod";
import { IsoDateTimeSchema, okOrError } from "../common";
import { SyncLinkStateSchema, SyncTargetSchema } from "./enums";

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
