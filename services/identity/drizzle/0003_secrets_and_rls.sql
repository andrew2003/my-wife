-- Encrypted per-user secrets (spec 40 section 4): ciphertext only, key_id per row for rotation.
CREATE TABLE "identity"."secrets" (
  "user_id" text NOT NULL,
  "kind" text NOT NULL,
  "key_id" text NOT NULL,
  "payload" text NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("user_id", "kind")
);

-- Row-level security (spec 40 section 5). The service switches to this role for each
-- user-scoped request and sets app.user_id; a superuser connection would bypass RLS
-- otherwise. Unset app.user_id matches no row.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'identity_app') THEN
    CREATE ROLE identity_app NOLOGIN;
  END IF;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END
$$;
GRANT USAGE ON SCHEMA "identity" TO identity_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "identity"."user_settings",
  "identity"."setting_audit",
  "identity"."onboarding_steps",
  "identity"."secrets"
TO identity_app;

ALTER TABLE "identity"."user_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "identity"."user_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON "identity"."user_settings"
  USING ("user_id" = current_setting('app.user_id', true))
  WITH CHECK ("user_id" = current_setting('app.user_id', true));

ALTER TABLE "identity"."setting_audit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "identity"."setting_audit" FORCE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON "identity"."setting_audit"
  USING ("user_id" = current_setting('app.user_id', true))
  WITH CHECK ("user_id" = current_setting('app.user_id', true));

ALTER TABLE "identity"."onboarding_steps" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "identity"."onboarding_steps" FORCE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON "identity"."onboarding_steps"
  USING ("user_id" = current_setting('app.user_id', true))
  WITH CHECK ("user_id" = current_setting('app.user_id', true));

ALTER TABLE "identity"."secrets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "identity"."secrets" FORCE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON "identity"."secrets"
  USING ("user_id" = current_setting('app.user_id', true))
  WITH CHECK ("user_id" = current_setting('app.user_id', true));
