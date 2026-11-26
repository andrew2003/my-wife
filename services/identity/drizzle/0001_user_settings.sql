CREATE TABLE "identity"."user_settings" (
  "user_id" text NOT NULL,
  "key" text NOT NULL,
  "value" jsonb NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("user_id", "key")
);

CREATE TABLE "identity"."setting_audit" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "actor_id" text NOT NULL,
  "key" text NOT NULL,
  "before" jsonb,
  "after" jsonb,
  "at" timestamp with time zone NOT NULL
);
CREATE INDEX "setting_audit_user_idx" ON "identity"."setting_audit" ("user_id", "at");
