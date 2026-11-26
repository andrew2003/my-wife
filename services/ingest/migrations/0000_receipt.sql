CREATE SCHEMA IF NOT EXISTS "ingest";

CREATE TABLE IF NOT EXISTS "ingest"."receipt" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "state" text NOT NULL,
  "message_id" text,
  "sender" text,
  "size_bytes" integer NOT NULL,
  "received_at" timestamp with time zone NOT NULL,
  "dkim_result" text NOT NULL,
  "reject_reason" text,
  "fingerprint" text,
  "template_id" text,
  "template_version" integer,
  "bank_transaction_ref" text,
  "fields" jsonb
);

CREATE INDEX IF NOT EXISTS "receipt_user_message_idx" ON "ingest"."receipt" ("user_id", "message_id");

-- Dedupe key: one parsed receipt per (user, bank transaction reference).
CREATE UNIQUE INDEX IF NOT EXISTS "receipt_parsed_ref_uq"
  ON "ingest"."receipt" ("user_id", "bank_transaction_ref")
  WHERE "state" = 'parsed';
