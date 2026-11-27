import type { AppConfig } from "@my-wife/config";
import { createServiceApp, type ServiceDeps } from "@my-wife/service-kit";
import {
  GoogleAuthService,
  InMemoryLinkStore,
  SyncAuthError,
  type GoogleOAuthClient,
  type LinkStore,
  type SyncTarget,
} from "./auth/google-auth";
import en from "./locales/en.json";
import vi from "./locales/vi.json";

export const SERVICE_NAME = "sync";

const CATALOGS: Record<"en" | "vi", Record<string, string>> = { en, vi };

export type SyncAuthDeps = {
  google: GoogleOAuthClient;
  store?: LinkStore;
  /** Reads the user's `google_sync` consent (from identity). */
  hasConsent(userId: string): Promise<boolean>;
  now?: () => Date;
};

export type SyncServiceDeps = ServiceDeps & { syncAuth?: SyncAuthDeps };

const isTarget = (v: unknown): v is SyncTarget => v === "sheets" || v === "calendar";

/** Factory used by main.ts, the dev runner and tests; no process-level globals (ADR 0007). */
export function createApp(config: AppConfig, deps: SyncServiceDeps = {}) {
  const app = createServiceApp({
    name: SERVICE_NAME,
    logLevel: config.logLevel,
    nats: deps.nats,
  });

  const msg = (code: string) =>
    CATALOGS[config.uiLanguage][`sync.error.${code}`] ?? CATALOGS.en[`sync.error.${code}`] ?? code;

  if (deps.syncAuth) {
    const a = deps.syncAuth;
    const now = a.now ?? (() => new Date());
    const auth = new GoogleAuthService({
      google: a.google,
      store: a.store ?? new InMemoryLinkStore(),
      encryptionKey: config.sessionSecret,
      hasConsent: a.hasConsent,
    });
    // The gateway sets x-user-id. Responses never carry token material.
    const userOf = (h: unknown) => (typeof h === "string" && h ? h : "local");
    const fail = (code: string) => ({ ok: false as const, error: { code, message: msg(code) } });

    app.post("/sync/link/start", async (req, reply) => {
      const target = (req.body as { target?: unknown } | null)?.target;
      if (!isTarget(target)) return reply.code(400).send(fail("bad_request"));
      try {
        const { authorizationUrl } = await auth.start(
          userOf(req.headers["x-user-id"]),
          target,
          now(),
        );
        return { ok: true, data: { authorizationUrl } };
      } catch (e) {
        if (e instanceof SyncAuthError)
          return reply.code(e.code === "consent_required" ? 403 : 400).send(fail(e.code));
        throw e;
      }
    });

    app.post("/sync/link/callback", async (req, reply) => {
      const b = (req.body ?? {}) as { target?: unknown; code?: unknown; state?: unknown };
      if (!isTarget(b.target) || typeof b.code !== "string" || typeof b.state !== "string") {
        return reply.code(400).send(fail("bad_request"));
      }
      try {
        const link = await auth.complete(
          userOf(req.headers["x-user-id"]),
          b.target,
          b.code,
          b.state,
          now(),
        );
        return { ok: true, data: { target: link.target, state: link.state } };
      } catch (e) {
        if (e instanceof SyncAuthError)
          return reply.code(e.code === "consent_required" ? 403 : 400).send(fail(e.code));
        throw e;
      }
    });

    app.get("/sync/status", async (req) => ({
      ok: true,
      data: await auth.status(userOf(req.headers["x-user-id"])),
    }));

    // Internal entry for the `consent.revoked` event.
    app.post("/events/consent-revoked", async (req) => {
      const b = (req.body ?? {}) as { userId?: unknown };
      if (typeof b.userId === "string") await auth.revokeConsent(b.userId);
      return { ok: true, data: {} };
    });
  }
  return app;
}
