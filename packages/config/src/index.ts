import { z } from "zod";
import { LocaleSchema, SERVICE_NAMES, type ServiceName } from "@my-wife/contracts";

const LoginMethodSchema = z.enum(["google", "magic_link"]);

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  UI_LANGUAGE: LocaleSchema.default("vi"),
  LOGIN_METHOD: LoginMethodSchema.default("google"),
  DATABASE_URL: z.string().default("postgres://mywife:mywife@localhost:5432/mywife"),
  NATS_URL: z.string().default("nats://localhost:4222"),
  /** Prefix that isolates a worktree inside the shared NATS stack. */
  NATS_SUBJECT_PREFIX: z.string().default(""),
  SESSION_SECRET: z.string().min(32),
  /** Base64 32-byte AES-256-GCM master key for user keys and tokens; secret routes are off without it. */
  SECRETS_MASTER_KEY: z.string().optional(),
  SECRETS_KEY_ID: z.string().default("k1"),
  /** Retired keys kept for decryption after a rotation: `id:base64,id:base64`. */
  SECRETS_PREVIOUS_KEYS: z.string().optional(),
});

export type AppConfig = {
  nodeEnv: "development" | "test" | "production";
  logLevel: string;
  uiLanguage: "vi" | "en";
  loginMethod: "google" | "magic_link";
  databaseUrl: string;
  natsUrl: string;
  natsSubjectPrefix: string;
  sessionSecret: string;
  secretsMasterKey?: string;
  secretsKeyId: string;
  secretsPreviousKeys?: string;
};

/** Parses environment variables once; every business number lives elsewhere as a setting. */
export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const e = EnvSchema.parse(env);
  return {
    nodeEnv: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    uiLanguage: e.UI_LANGUAGE,
    loginMethod: e.LOGIN_METHOD,
    databaseUrl: e.DATABASE_URL,
    natsUrl: e.NATS_URL,
    natsSubjectPrefix: e.NATS_SUBJECT_PREFIX,
    sessionSecret: e.SESSION_SECRET,
    secretsMasterKey: e.SECRETS_MASTER_KEY,
    secretsKeyId: e.SECRETS_KEY_ID,
    secretsPreviousKeys: e.SECRETS_PREVIOUS_KEYS,
  };
}

const BASE_PORT = 4000;

/** Stable port per service, used by the dev runner and compose. */
export function servicePort(name: ServiceName): number {
  return BASE_PORT + SERVICE_NAMES.indexOf(name);
}
