import { randomUUID } from "node:crypto";
import type { FastifyReply } from "fastify";
import type { AppConfig } from "@my-wife/config";
import {
  CompleteOnboardingStepRequestSchema,
  EVENT_SCHEMA_VERSION,
  OnboardingStepSchema,
  SETTINGS,
  type EventEnvelope,
  type EventPayload,
  type EventSubject,
  SETTING_KEYS,
  UpdateSettingRequestSchema,
  validateSettingValue,
  type SettingKey,
} from "@my-wife/contracts";
import { createServiceApp, type ServiceDeps } from "@my-wife/service-kit";
import {
  createMemoryStore,
  type IdentityStore,
  type InvitationRecord,
  type OnboardingStepRecord,
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
  /** Announces events (NATS in production); a failure must not undo the sign-up. */
  publish?: (event: EventEnvelope) => void | Promise<void>;
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
    deps.settings?.[key] ?? (SETTINGS[key].default as number);
  const bootstrap = deps.bootstrapAdminEmail?.toLowerCase();

  const publicUser = (u: UserRecord) => ({
    id: u.id,
    email: u.email,
    state: u.state,
    role: u.role,
    locale: u.locale,
    lastSeenAt: u.lastSeenAt,
  });

  /** Publishes an event. A failure is logged (type and message only) and reported, never thrown. */
  async function emit<S extends EventSubject>(
    type: S,
    userId: string,
    payload: EventPayload<S>,
  ): Promise<boolean> {
    try {
      await deps.publish?.({
        id: randomUUID(),
        type,
        userId,
        occurredAt: now().toISOString(),
        schemaVersion: EVENT_SCHEMA_VERSION,
        payload,
      } as EventEnvelope);
      return true;
    } catch (err) {
      app.log.error(
        { eventType: type, err: err instanceof Error ? err.message : "unknown" },
        "event publish failed; it will be retried",
      );
      return false;
    }
  }

  /** user.activated is owed until published; every later sign-in retries it. */
  async function ensureActivated(user: UserRecord): Promise<UserRecord> {
    if (user.activatedEventAt) return user;
    if (!(await emit("user.activated", user.id, {}))) return user;
    const marked = { ...user, activatedEventAt: now().toISOString() };
    await store.saveUser(marked);
    return marked;
  }

  async function createUser(email: string, role: "user" | "admin") {
    if (role === "user" && (await store.countUsers()) >= setting("identity.max_users")) {
      return "identity.user_limit_reached" as const;
    }
    const user: UserRecord = {
      id: randomUUID(),
      email,
      state: "active",
      role,
      locale: config.uiLanguage,
      lastSeenAt: null,
      activatedEventAt: null,
    };
    if (await store.insertUser(user)) return ensureActivated(user);
    // A concurrent first sign-in won the unique email; use its row.
    const winner = await store.findUserByEmail(email);
    if (!winner) return "identity.account_unavailable" as const;
    return winner.state === "active"
      ? ensureActivated(winner)
      : ("identity.account_unavailable" as const);
  }

  /** Invitation-only sign-up: an existing user, the bootstrap admin, or an open invitation. */
  async function resolveUser(email: string, consume: boolean) {
    const existing = await store.findUserByEmail(email);
    if (existing)
      return existing.state === "active"
        ? ensureActivated(existing)
        : ("identity.account_unavailable" as const);
    if (bootstrap && email === bootstrap)
      return consume ? createUser(email, "admin") : ("pending" as const);
    const invitation = await store.findOpenInvitationByEmail(email, now());
    if (!invitation) return "identity.not_invited" as const;
    if (!consume) return "pending" as const;
    const user = await createUser(email, "user");
    if (typeof user !== "string")
      await store.saveInvitation({ ...invitation, usedAt: now().toISOString() });
    return user;
  }

  async function session(user: UserRecord) {
    const exp = new Date(now().getTime() + setting("identity.session_ttl_days") * DAY);
    const id = randomUUID();
    await store.saveSession({
      id,
      userId: user.id,
      createdAt: now().toISOString(),
      expiresAt: exp.toISOString(),
      revokedAt: null,
    });
    return {
      user: publicUser(user),
      expiresAt: exp.toISOString(),
      sessionToken: signSession(
        { sub: user.id, sid: id, exp: Math.floor(exp.getTime() / 1000) },
        config.sessionSecret,
      ),
    };
  }

  const methodGuard = (method: "google" | "magic_link", reply: FastifyReply) =>
    config.loginMethod === method ? null : fail(reply, 404, "identity.method_disabled");

  app.get("/auth/method", async () => ({ ok: true, data: { method: config.loginMethod } }));

  async function announceInvited(invitation: InvitationRecord, adminId: string) {
    if (invitation.invitedEventAt) return;
    const sent = await emit("user.invited", adminId, {
      invitationId: invitation.id,
      expiresAt: invitation.expiresAt,
    });
    if (sent) await store.saveInvitation({ ...invitation, invitedEventAt: now().toISOString() });
  }

  app.post("/invitations", async (req, reply) => {
    if (req.headers["x-user-role"] !== "admin") return fail(reply, 403, "identity.forbidden");
    const adminId = req.headers["x-user-id"];
    if (typeof adminId !== "string" || !adminId)
      return fail(reply, 401, "identity.unauthenticated");
    const email = String((req.body as { email?: string } | undefined)?.email ?? "")
      .trim()
      .toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
      return fail(reply, 400, "identity.invalid_email");
    const view = (i: InvitationRecord) => ({
      invitation: {
        id: i.id,
        email: i.email,
        expiresAt: i.expiresAt,
        usedAt: null,
        revokedAt: null,
      },
    });
    // Retry-safe: an open invitation is reused (its token was already handed over) and only
    // its owed user.invited event is re-sent.
    const open = await store.findOpenInvitationByEmail(email, now());
    if (open) {
      await announceInvited(open, adminId);
      return { ok: true, data: view(open) };
    }
    const token = newToken();
    const invitation: InvitationRecord = {
      id: randomUUID(),
      email,
      tokenHash: hashToken(token),
      expiresAt: new Date(
        now().getTime() + setting("identity.invitation_ttl_days") * DAY,
      ).toISOString(),
      usedAt: null,
      revokedAt: null,
      invitedEventAt: null,
    };
    await store.saveInvitation(invitation);
    await deps.onInvitation?.(email, token);
    await announceInvited(invitation, adminId);
    return reply.code(201).send({ ok: true, data: view(invitation) });
  });

  app.post("/invitations/accept", async (req, reply) => {
    const token = String((req.body as { token?: string } | undefined)?.token ?? "");
    const invitation = token ? await store.findInvitationByTokenHash(hashToken(token)) : undefined;
    if (
      !invitation ||
      invitation.usedAt ||
      invitation.revokedAt ||
      new Date(invitation.expiresAt) <= now()
    ) {
      return fail(reply, 400, "identity.invitation_invalid");
    }
    const existing = await store.findUserByEmail(invitation.email);
    const user = existing
      ? await ensureActivated(existing)
      : await createUser(invitation.email, "user");
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
    return { ok: true, data: await session(user) };
  });

  app.post("/auth/magic-link", async (req, reply) => {
    const blocked = methodGuard("magic_link", reply);
    if (blocked) return blocked;
    const email = String((req.body as { email?: string } | undefined)?.email ?? "")
      .trim()
      .toLowerCase();
    // Same answer whether or not the email is known: no account enumeration.
    const known = email ? await resolveUser(email, false) : "identity.not_invited";
    const eligible = typeof known !== "string" || known === "pending";
    if (eligible) {
      const token = newToken();
      await store.saveLoginToken({
        tokenHash: hashToken(token),
        email,
        expiresAt: new Date(
          now().getTime() + setting("identity.magic_link_ttl_minutes") * MINUTE,
        ).toISOString(),
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
    return { ok: true, data: await session(user) };
  });

  /** The gateway sets the verified user id; services never read the session cookie. */
  const callerId = (headers: Record<string, unknown>) => {
    const id = headers["x-user-id"];
    return typeof id === "string" && id ? id : null;
  };

  /** Registry default merged with the user's own overrides. */
  async function readSettings(userId: string) {
    const overrides = await store.getSettingOverrides(userId);
    const values: Record<string, unknown> = {};
    for (const key of SETTING_KEYS) {
      values[key] = Object.prototype.hasOwnProperty.call(overrides, key)
        ? overrides[key]
        : SETTINGS[key].default;
    }
    return values;
  }

  app.get("/settings", async (req, reply) => {
    const userId = callerId(req.headers);
    if (!userId) return fail(reply, 401, "identity.unauthenticated");
    return { ok: true, data: { values: await readSettings(userId) } };
  });

  app.put("/settings", async (req, reply) => {
    const userId = callerId(req.headers);
    if (!userId) return fail(reply, 401, "identity.unauthenticated");
    const body = UpdateSettingRequestSchema.safeParse(req.body);
    if (!body.success) return fail(reply, 400, "identity.invalid_setting");
    const { key, value: raw } = body.data;
    const checked = validateSettingValue(key, raw);
    if (!checked.success) return fail(reply, 400, "identity.invalid_setting");
    // Admin-scope keys need the admin role set by the gateway; same convention as /invitations.
    if (SETTINGS[key].scope === "admin" && req.headers["x-user-role"] !== "admin")
      return fail(reply, 403, "identity.forbidden");
    const before = (await readSettings(userId))[key];
    const at = now().toISOString();
    if (JSON.stringify(before) !== JSON.stringify(checked.data)) {
      await store.saveSetting(userId, key, checked.data, {
        id: randomUUID(),
        userId,
        actorId: userId,
        key,
        before,
        after: checked.data,
        at,
      });
      await emit("user.updated", userId, { changedKeys: [key] });
    }
    // Tightening or loosening is classified by `rules`; until it is wired every change is
    // effective now (see docs/decisions.md).
    return { ok: true, data: { key, direction: "tightening" as const, effectiveFrom: at } };
  });

  /** Setup questions that map to a user setting; the answers are stored as those settings. */
  const SETUP_ANSWER_KEYS: readonly SettingKey[] = [
    "routine.wake.time",
    "routine.sleep.start",
    "budget.cycle_weeks",
  ];

  app.post("/onboarding/setup-answers", async (req, reply) => {
    const userId = callerId(req.headers);
    if (!userId) return fail(reply, 401, "identity.unauthenticated");
    const raw = (req.body as { answers?: unknown } | undefined)?.answers;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      return fail(reply, 400, "identity.invalid_setting");
    const entries = Object.entries(raw);
    if (entries.length === 0) return fail(reply, 400, "identity.invalid_setting");
    const checked: [SettingKey, unknown][] = [];
    for (const [key, value] of entries) {
      if (!(SETUP_ANSWER_KEYS as readonly string[]).includes(key))
        return fail(reply, 400, "identity.invalid_setting");
      const result = validateSettingValue(key as SettingKey, value);
      if (!result.success) return fail(reply, 400, "identity.invalid_setting");
      checked.push([key as SettingKey, result.data]);
    }
    // Everything is validated before anything is written: a bad answer stores nothing.
    const current = await readSettings(userId);
    const at = now().toISOString();
    const changes = checked
      .filter(([key, value]) => JSON.stringify(current[key]) !== JSON.stringify(value))
      .map(([key, value]) => ({
        key,
        value,
        audit: {
          id: randomUUID(),
          userId,
          actorId: userId,
          key,
          before: current[key],
          after: value,
          at,
        },
      }));
    // One transaction: either every changed answer is saved or none, so the event never
    // misses a stored change.
    if (changes.length > 0) await store.saveSettings(userId, changes);
    const changedKeys = changes.map((c) => c.key);
    if (changedKeys.length > 0) await emit("user.updated", userId, { changedKeys });
    return { ok: true, data: { changedKeys } };
  });

  app.post("/onboarding/steps", async (req, reply) => {
    const userId = callerId(req.headers);
    if (!userId) return fail(reply, 401, "identity.unauthenticated");
    const body = CompleteOnboardingStepRequestSchema.safeParse(req.body);
    if (!body.success) return fail(reply, 400, "identity.invalid_step");
    const { step } = body.data;
    // The first submission wins; later ones only retry an event that is still owed.
    const record: OnboardingStepRecord = (await store.findOnboardingStep(userId, step)) ?? {
      userId,
      step,
      skipped: body.data.skipped,
      completedAt: now().toISOString(),
      eventAt: null,
    };
    if (!record.eventAt) {
      await store.saveOnboardingStep(record);
      const sent = await emit("onboarding.step_completed", userId, {
        step,
        skipped: record.skipped,
      });
      if (!sent) return fail(reply, 503, "identity.event_unavailable");
      await store.saveOnboardingStep({ ...record, eventAt: now().toISOString() });
    }
    return { ok: true, data: { step, skipped: record.skipped } };
  });

  /** Whether a step is finished (event delivered) and whether it was skipped. */
  app.get("/onboarding/steps/:step", async (req, reply) => {
    const userId = callerId(req.headers);
    if (!userId) return fail(reply, 401, "identity.unauthenticated");
    const step = OnboardingStepSchema.safeParse((req.params as { step: string }).step);
    if (!step.success) return fail(reply, 400, "identity.invalid_step");
    const record = await store.findOnboardingStep(userId, step.data);
    return {
      ok: true,
      data: {
        step: step.data,
        completed: Boolean(record?.eventAt),
        skipped: record?.skipped ?? false,
      },
    };
  });

  /** Internal: the gateway verifies every request's session through this. */
  app.post("/sessions/verify", async (req, reply) => {
    const token = String((req.body as { token?: string } | undefined)?.token ?? "");
    const payload = verifySession(token, config.sessionSecret, now());
    const user = payload ? await store.findUserById(payload.sub) : undefined;
    const stored = payload ? await store.findSession(payload.sid) : undefined;
    if (
      !payload ||
      !user ||
      user.state !== "active" ||
      !stored ||
      stored.userId !== user.id ||
      stored.revokedAt
    )
      return fail(reply, 401, "identity.invalid_session");
    return {
      ok: true,
      data: { user: publicUser(user), expiresAt: new Date(payload.exp * 1000).toISOString() },
    };
  });

  return app;
}
