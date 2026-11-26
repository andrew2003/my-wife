CREATE TABLE "identity"."onboarding_steps" (
  "user_id" text NOT NULL,
  "step" text NOT NULL,
  "skipped" boolean NOT NULL,
  "completed_at" timestamp with time zone NOT NULL,
  "event_at" timestamp with time zone,
  PRIMARY KEY ("user_id", "step")
);
