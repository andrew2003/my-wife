import { createHmac } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { IdentityStore } from "@my-wife/identity";

export const E2E_USER_ID = "0190a0a0-0000-7000-8000-0000000000e2";
export const E2E_SESSION_ID = "0190a0a0-0000-7000-8000-0000000000e3";
export const E2E_USER_EMAIL = "e2e@example.test";
const SESSION_DAYS = 30;

/**
 * Same format as identity's signSession (base64url JSON payload, "." and HMAC-SHA256).
 * Identity exports no signer, and identity code is out of scope here; the gateway test
 * proves identity accepts what this produces.
 */
export function sign(payload: { sub: string; sid: string; exp: number }, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

export type SeedOptions = {
  env: Record<string, string | undefined>;
  store: IdentityStore;
  secret: string;
  now: Date;
};

/**
 * End-to-end hook (#255): saves one test user and one session in the given store and writes
 * the signed cookie value to E2E_SESSION_COOKIE_FILE (mode 0600). Returns false when the flag
 * is unset. Throws before writing anything when misconfigured or in production.
 * The cookie value is never logged.
 */
export async function seedE2eSession(opts: SeedOptions): Promise<boolean> {
  const { env, store, secret, now } = opts;
  if (env.E2E_SEED_SESSION !== "1") return false;
  if (env.NODE_ENV === "production") {
    throw new Error("E2E_SEED_SESSION must not be set when NODE_ENV is production");
  }
  const file = env.E2E_SESSION_COOKIE_FILE;
  if (!file) throw new Error("E2E_SEED_SESSION requires E2E_SESSION_COOKIE_FILE");

  const expiresAt = new Date(now.getTime() + SESSION_DAYS * 86_400_000);
  await store.saveUser({
    id: E2E_USER_ID,
    email: E2E_USER_EMAIL,
    state: "active",
    role: "user",
    locale: "en",
    lastSeenAt: null,
    activatedEventAt: now.toISOString(),
  });
  await store.saveSession({
    id: E2E_SESSION_ID,
    userId: E2E_USER_ID,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    revokedAt: null,
  });
  const value = sign(
    { sub: E2E_USER_ID, sid: E2E_SESSION_ID, exp: Math.floor(expiresAt.getTime() / 1000) },
    secret,
  );
  await writeFile(file, value, { mode: 0o600 });
  return true;
}
