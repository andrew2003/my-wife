-- Foreign-card authorization and debit pairing (MW-024).
ALTER TABLE "ingest"."receipt" ADD COLUMN IF NOT EXISTS "pair_key" text;
ALTER TABLE "ingest"."receipt" ADD COLUMN IF NOT EXISTS "paired_receipt_id" text;

CREATE INDEX IF NOT EXISTS "receipt_user_pair_key_idx" ON "ingest"."receipt" ("user_id", "pair_key");
