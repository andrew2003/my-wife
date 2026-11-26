import { index, integer, jsonb, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { serviceSchema } from "@my-wife/service-kit";

const schema = serviceSchema("ingest");

/** One row per inbound message. The raw body is not stored here (retention follow-up). */
export const receipt = schema.table(
  "receipt",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    state: text("state").notNull(),
    messageId: text("message_id"),
    sender: text("sender"),
    sizeBytes: integer("size_bytes").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    dkimResult: text("dkim_result").notNull(),
    rejectReason: text("reject_reason"),
    fingerprint: text("fingerprint"),
    templateId: text("template_id"),
    templateVersion: integer("template_version"),
    bankTransactionRef: text("bank_transaction_ref"),
    fields: jsonb("fields"),
    pairKey: text("pair_key"),
    pairedReceiptId: text("paired_receipt_id"),
  },
  (t) => [
    index("receipt_user_message_idx").on(t.userId, t.messageId),
    // Dedupe key: one parsed receipt per (user, bank transaction reference).
    uniqueIndex("receipt_parsed_ref_uq")
      .on(t.userId, t.bankTransactionRef)
      .where(sql`${t.state} = 'parsed'`),
    index("receipt_user_pair_key_idx").on(t.userId, t.pairKey),
  ],
);
