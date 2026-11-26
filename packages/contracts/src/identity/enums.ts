import { z } from "zod";

export const AccountStateSchema = z.enum(["invited", "active", "closing", "closed", "suspended"]);
export const RoleSchema = z.enum(["user", "admin"]);
export const LoginMethodSchema = z.enum(["google", "magic_link"]);
export const IncidentStateSchema = z.enum(["declared", "active", "ended", "cancelled"]);
export const FeatureFlagSchema = z.enum(["camera_supervision", "wake_photo", "sync", "email_ingest"]);
export const StarterPackSchema = z.enum(["student", "regular_worker", "freelancer"]);
export const OnboardingStepSchema = z.enum([
  "tour",
  "demo_account",
  "connect_channel",
  "llm_key",
  "mail_forwarding",
  "notifications_camera_install",
  "do_not_disturb",
  "qa_templates",
  "sign_contract",
]);
export const SettingScopeSchema = z.enum(["user", "admin"]);
export const SettingOwnerSchema = z.enum([
  "identity",
  "budget",
  "ingest",
  "rules",
  "schedule",
  "monitor",
  "ai",
  "notify",
  "sync",
  "web",
  "admin",
]);
