import { z } from "zod";
import { IdSchema, IsoDateTimeSchema, okOrError } from "../common";
import { ReceiptStateSchema, TemplateStateSchema } from "./enums";

/** Cloudflare Email Worker -> ingest webhook. Authenticated with a shared secret header. */
export const InboundEmailWebhookRequestSchema = z.object({
  toAddress: z.string().min(1),
  rawBase64: z.string().min(1),
  sizeBytes: z.number().int().positive(),
});
export const InboundEmailWebhookResponseSchema = okOrError(
  z.object({ receiptId: IdSchema, state: ReceiptStateSchema }),
);

export const DeclareSenderRequestSchema = z.object({
  senderKey: z.string().min(1),
  bankAccountId: IdSchema,
});

export const BankSenderMapEntrySchema = z.object({
  senderKey: z.string().min(1),
  senderAddress: z.string().min(1),
  dkimDomain: z.string().min(1),
});
export const BankSenderMapResponseSchema = okOrError(
  z.object({ entries: z.array(BankSenderMapEntrySchema) }),
);

export const ConfirmTemplateRequestSchema = z.object({
  receiptId: IdSchema,
  accept: z.boolean(),
});
export const ReceiptTemplateViewSchema = z.object({
  id: IdSchema,
  sender: z.string(),
  state: TemplateStateSchema,
  version: z.number().int().positive(),
  matchCount: z.number().int().nonnegative(),
});

export const ForwardingAddressResponseSchema = okOrError(
  z.object({
    address: z.string().min(1),
    pendingConfirmationCode: z.string().nullable(),
    confirmationExpiresAt: IsoDateTimeSchema.nullable(),
  }),
);
