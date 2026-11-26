import { randomUUID } from "node:crypto";
import type { FastifyReply } from "fastify";
import type { AppConfig } from "@my-wife/config";
import { SETTINGS, type SettingKey } from "@my-wife/contracts";
import { createServiceApp, type ServiceDeps } from "@my-wife/service-kit";
import {
  createMemoryStore,
  type IdentityStore,
  type InvitationRecord,
  type UserRecord,
} from "./store";
import { hashToken, newToken, signSession, verifySession } from "./tokens";

export const SERVICE_NAME = "identity";

export type IdentityDeps = ServiceDeps & {
  store?: IdentityStore;
  /** Time is a parameter so tests can simulate it. */
  now?: () => Date;
  /** Overrides of admin settings; defaults come from the contracts registry. */
  settings?: Partial<Record<SettingKey, number>>;
  /** Delivery is notify's job; identity only hands over the one-time token. */
  onInvitation?: (email: string, token: string) => void | Promise<void>;
  onMagicLink?: (email: string, token: string) => void | Promise<void>;
  /** Verifies a Google ID token and returns the verified email, or null. */
  googleVerifier?: (idToken: string) => Promise<{ email: string } | null>;
  /** The first admin signs in without an invitation. */
  bootstrapAdminEmail?: string;
};

const MINUTE = 60_000;
const DAY = 86_400_000;

function fail(reply: FastifyReply, status: number, code: string) {
  return reply.code(status).send({ ok: false, error: { code } });
}

export function createApp(config: AppConfig, deps: IdentityDeps = {}) {
  const app = createServiceApp({ name: SERVICE_NAME, logLevel: config.logLevel, nats: deps.nats });
  const store = deps.store ?? createMemoryStore();
  const now = deps.now ?? (() => new Date());
  const setting = (key: SettingKey): number =>
    (deps.settings?.[key] ?? (SETTINGS[key].default as number));
  const bootstrap = deps.bootstrapAdminEmail?.toLowerCase();

  const publicUser = (u: UserRecord) => ({
    id: u.id, email: u.email, state: u.state, role: u.role, locale: u.locale, lastSeenAt: u.lastSeenAt,
  });

  async function createUser(email: string, role: "user" | "admin") {
    if (role === "user" && (await store.countUsers()) >= setting("identity.max_users")) {
      return "identity.user_limit_reached" as const;
    }
    const user: UserRecord = {
      id: randomUUID(), email, state: "active", role, locale: config.uiLanguage, lastSeenAt: null,
    };
    await store.saveUser(user);
    return user;
  }

  /** Invitation-only sign-up: an existing user, the bootstrap admin, or an open invitation. */
  async function resolveUser(email: string, consume: boolean) {
    const existing = await store.findUserByEmail(email);
    if (existing) return existing.state === "active" ? existing : ("identity.account_unavailable" as const);
    if (bootstrap && email === bootstrap) return consume ? createUser(email, "admin") : ("pending" as const);
    const invitation = await store.findOpenInvitationByEmail(email, now());
    if (!invitation) return "identity.not_invited" as const;
    if (!consume) return "pending" as const;
    const user = await createUser(email, "user");
    if (typeof user !== "string") await store.saveInvitation({ ...invitation, usedAt: now().toISOString() });
    return user;
  }

  function session(user: UserRecord) {
    const exp = new Date(now().getTime() + setting("identity.session_ttl_days") * DAY);
    return {
      user: publicUser(user),
      expiresAt: exp.toISOString(),
      sessionToken: signSession({ sub: user.id, exp: Math.floor(exp.getTime() / 1000) }, config.sessionSecret),
    };
  }

  const methodGuard = (method: "google" | "magic_link", reply: FastifyReply) =>
    config.loginMethod === method ? null : fail(reply, 404, "identity.method_disabled");

  app.get("/auth/method", async () => ({ ok: true, data: { method: config.loginMethod } }));

  app.post("/invitations", async (req, reply) => {
    if (req.headers["x-user-role"] !== "admin") return fail(reply, 403, "identity.forbidden");
    const email = String((req.body as { email?: string } | undefined)?.email ?? "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail(reply, 400, "identity.invalid_email");
    const token = newToken();
    const invitation: InvitationRecord = {
      id: randomUUID(),
      email,
      tokenHash: hashToken(token),
      expiresAt: new Date(now().getTime() + setting("identity.invitation_ttl_days") * DAY).toISOString(),
      usedAt: null,
      revokedAt: null,
    };
    await store.saveInvitation(invitation);
    await deps.onInvitation?.(email, token);
    return reply.code(201).send({
      ok: true,
      data: {
        invitation: {
          id: invitation.id, email, expiresAt: invitation.expiresAt, usedAt: null, revokedAt: null,
        },
      },
    });
  });

  app.post("/invitations/accept", async (req, reply) => {
    const token = String((req.body as { token?: string } | undefined)?.token ?? "");
    const invitation = token ? await store.findInvitationByTokenHash(hashToken(token)) : undefined;
    if (!invitation || invitation.usedAt || invitation.revokedAt || new Date(invitation.expiresAt) <= now()) {
      return fail(reply, 400, "identity.invitation_invalid");
    }
    const existing = await store.findUserByEmail(invitation.email);
    const user = existing ?? (await createUser(invitation.email, "user"));
    if (typeof user === "string") return fail(reply, 403, user);
    await store.saveInvitation({ ...invitation, usedAt: now().toISOString() });
    return { ok: true, data: { user: publicUser(user) } };
  });

  app.post("/auth/google", async (req, reply) => {
    const blocked = methodGuard("google", reply);
    if (blocked) return blocked;
    const idToken = String((req.body as { idToken?: string } | undefined)?.idToken ?? "");
    const verified = deps.googleVerifier ? await deps.googleVerifier(idToken) : null;
    if (!verified) return fail(reply, 401, "identity.invalid_credentials");
    const user = await resolveUser(verified.email.toLowerCase(), true);
    if (typeof user === "string") return fail(reply, 403, user);
    return { ok: true, data: session(user) };
  });

  app.post("/auth/magic-link", async (req, reply) => {
    const blocked = methodGuard("magic_link", reply);
    if (blocked) return blocked;
    const email = String((req.body as { email?: string } | undefined)?.email ?? "").trim().toLowerCase();
    // Same answer whether or not the email is known: no account enumeration.
    const known = email ? await resolveUser(email, false) : "identity.not_invited";
    const eligible = typeof known !== "string" || known === "pending";
    if (eligible) {
      const token = newToken();
      await store.saveLoginToken({
        tokenHash: hashToken(token),
        email,
        expiresAt: new Date(now().getTime() + setting("identity.magic_link_ttl_minutes") * MINUTE).toISOString(),
        usedAt: null,
      });
      await deps.onMagicLink?.(email, token);
    }
    return reply.code(202).send({ ok: true, data: {} });
  });

  app.post("/auth/magic-link/verify", async (req, reply) => {
    const blocked = methodGuard("magic_link", reply);
    if (blocked) return blocked;
    const token = String((req.body as { token?: string } | undefined)?.token ?? "");
    const record = token ? await store.findLoginToken(hashToken(token)) : undefined;
    if (!record || record.usedAt || new Date(record.expiresAt) <= now()) {
      return fail(reply, 400, "identity.link_invalid");
    }
    const user = await resolveUser(record.email, true);
    if (typeof user === "string") return fail(reply, 403, user);
    await store.saveLoginToken({ ...record, usedAt: now().toISOString() });
    return { ok: true, data: session(user) };
  });

  /** Internal: the gateway verifies every request's session through this. */
  app.post("/sessions/verify", async (req, reply) => {
    const token = String((req.body as { token?: string } | undefined)?.token ?? "");
    const payload = verifySession(token, config.sessionSecret, now());
    const user = payload ? await store.findUserById(payload.sub) : undefined;
    if (!payload || !user || user.state !== "active") return fail(reply, 401, "identity.invalid_session");
    return { ok: true, data: { user: publicUser(user), expiresAt: new Date(payload.exp * 1000).toISOString() } };
  });

  return app;
}
