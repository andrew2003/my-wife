CREATE SCHEMA IF NOT EXISTS "identity";

CREATE TYPE "identity"."user_state" AS ENUM ('invited', 'active', 'closing', 'closed', 'suspended');
CREATE TYPE "identity"."user_role" AS ENUM ('user', 'admin');

CREATE TABLE "identity"."users" (
  "id" text PRIMARY KEY NOT NULL,
  "email" text NOT NULL,
  "state" "identity"."user_state" NOT NULL,
  "role" "identity"."user_role" NOT NULL,
  "locale" text NOT NULL,
  "last_seen_at" timestamp with time zone
);
CREATE UNIQUE INDEX "users_email_idx" ON "identity"."users" ("email");

CREATE TABLE "identity"."invitations" (
  "id" text PRIMARY KEY NOT NULL,
  "email" text NOT NULL,
  "token_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "revoked_at" timestamp with time zone
);
CREATE UNIQUE INDEX "invitations_token_hash_idx" ON "identity"."invitations" ("token_hash");
CREATE INDEX "invitations_email_idx" ON "identity"."invitations" ("email");

CREATE TABLE "identity"."login_tokens" (
  "token_hash" text PRIMARY KEY NOT NULL,
  "email" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone
);

CREATE TABLE "identity"."sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "identity"."users" ("id"),
  "created_at" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone
);
CREATE INDEX "sessions_user_idx" ON "identity"."sessions" ("user_id");
