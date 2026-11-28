import { tmpdir } from "node:os";
import { join } from "node:path";

/** Shared settings for the suite; every value can be overridden from the environment. */
export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3100);
export const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
export const GATEWAY_URL = "http://127.0.0.1:4000";
export const E2E_DB = process.env.E2E_DB_NAME ?? "mywife_e2e";
export const DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? `postgres://mywife:mywife@localhost:5432/${E2E_DB}`;
export const NATS_SUBJECT_PREFIX = process.env.E2E_NATS_PREFIX ?? "e2e";
/** Camera analysis must use the CPU delegate: no GPU is assumed (CLAUDE.md). */
export const CAMERA_DELEGATE = "cpu";
export const FAKE_VIDEO = new URL("../.cache/fake-camera.y4m", import.meta.url).pathname;
/** Written by the dev runner (outside the repo, mode 0600); read by the sign-in fixture. */
export const SESSION_COOKIE_FILE =
  process.env.E2E_SESSION_COOKIE_FILE ?? join(tmpdir(), `mywife-e2e-session-${E2E_DB}.txt`);
/** Manual sign-in helper of the dev runner; signs in the seeded demo user. */
export const DEMO_LOGIN_URL = "http://127.0.0.1:4100";
