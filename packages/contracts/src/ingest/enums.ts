import { z } from "zod";

export const ReceiptStateSchema = z.enum([
  "received",
  "rejected",
  "duplicate",
  "parsing",
  "needs_confirmation",
  "parsed",
  "failed",
]);
export type ReceiptState = z.infer<typeof ReceiptStateSchema>;

export const ReceiptRejectReasonSchema = z.enum([
  "dkim_invalid",
  "sender_unknown",
  "unsigned",
  "no_consent",
  "too_large",
  "duplicate",
]);
export const ReceiptSourceSchema = z.enum(["parser", "llm"]);
export const TemplateStateSchema = z.enum(["learning", "trusted"]);
export type TemplateState = z.infer<typeof TemplateStateSchema>;
