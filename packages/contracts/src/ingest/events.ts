import { z } from "zod";
import { DirectionSchema } from "../budget/enums";
import { IdSchema, IsoDateTimeSchema, NonNegativeVndSchema } from "../common";
import { ReceiptRejectReasonSchema, ReceiptSourceSchema } from "./enums";

/** Normalized receipt facts. Never carries a category or type: `budget` decides. */
export const ReceiptParsedPayloadSchema = z
  .object({
    receiptId: IdSchema,
    bankTransactionRef: z.string().min(1),
    bankAccountHint: z.string().min(1),
    direction: DirectionSchema,
    amountVnd: NonNegativeVndSchema,
    currency: z.string().length(3),
    foreignAmountMinor: z.number().int().nonnegative().optional(),
    counterparty: z.string().nullable(),
    memo: z.string(),
    occurredAt: IsoDateTimeSchema,
    balanceAfterVnd: z.number().int().safe().optional(),
    merchant: z.string().optional(),
    source: ReceiptSourceSchema,
    templateId: IdSchema.optional(),
    templateVersion: z.number().int().positive().optional(),
    confidence: z.number().min(0).max(1).optional(),
    fxProvisional: z.boolean(),
  })
  .strict();
export type ReceiptParsedPayload = z.infer<typeof ReceiptParsedPayloadSchema>;

export const ingestEvents = {
  "receipt.parsed": ReceiptParsedPayloadSchema,
  "receipt.unknown": z.object({
    receiptId: IdSchema,
    templateFingerprint: z.string().min(1),
    sender: z.string().min(1),
  }),
  "receipt.rejected": z.object({
    receiptId: IdSchema,
    reason: ReceiptRejectReasonSchema,
    sender: z.string().nullable(),
  }),
  "receipt.failed": z.object({ receiptId: IdSchema, reason: z.string().min(1) }),
  "template.promoted": z.object({ templateId: IdSchema, version: z.number().int().positive() }),
  "template.demoted": z.object({ templateId: IdSchema, version: z.number().int().positive() }),
  "forwarding.confirmation_received": z.object({
    code: z.string().min(1),
    expiresAt: IsoDateTimeSchema,
  }),
  /** Ingest asks `ai` to read an unknown template; the model gets no tools. */
  "template.read_requested": z.object({
    receiptId: IdSchema,
    templateFingerprint: z.string().min(1),
  }),
};
