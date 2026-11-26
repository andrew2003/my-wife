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
