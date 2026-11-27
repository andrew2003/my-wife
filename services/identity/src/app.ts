import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";
import type { FastifyReply } from "fastify";
import type { AppConfig } from "@my-wife/config";
import {
  CompleteOnboardingStepRequestSchema,
  DeclareIncidentRequestSchema,
  SenderMapEntryRequestSchema,
  IsoDateTimeSchema,
  EVENT_SCHEMA_VERSION,
  ConsentKindSchema,
  ConsentRequestSchema,
  FeatureFlagSchema,
  SetFeatureFlagRequestSchema,
  OnboardingStepSchema,
  SupervisionLevelSchema,
  type ConsentKind,
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
import {
  createConsentStore,
  effectiveSupervisionLevel,
  evaluateConsent,
  type ConsentStore,
} from "./consents";
import { anonymisedEmail, type PenaltyPort } from "./deletion";
import { buildExportArchive, createExportStore, type ExportStore } from "./export";
import {
  createIncidentStore,
  incidentCoversUser,
  type Incident,
  type IncidentStore,
} from "./incidents";
import {
  createFeatureFlagStore,
  featureDisabledNoticeKey,
  type FeatureFlagStore,
} from "./feature-flags";
import { createSenderMapStore, type SenderMapEntry, type SenderMapStore } from "./sender-map";
import { encryptSecret, parseKeyring } from "./secrets-crypto";
import { hashToken, newToken, signSession, verifySession } from "./tokens";

export const SERVICE_NAME = "identity";

export type IdentityDeps = ServiceDeps & {
  store?: IdentityStore;
  /** Consents and their audit trail; in memory until the Drizzle store lands. */
  consentStore?: ConsentStore;
  /** Open (suspended or due) penalties of a user, from `rules`. Without it none are assumed. */
  penalties?: PenaltyPort;
  /** Incidents and the admin audit log; in memory until the Drizzle store lands. */
  incidentStore?: IncidentStore;
  /** The global bank sender map; in memory until the Drizzle store lands. */
  senderMapStore?: SenderMapStore;
  /** Per-user feature flags; in memory until the Drizzle store lands. */
  featureFlagStore?: FeatureFlagStore;
  /** Built export archives; in memory until the Drizzle store lands. */
  exportStore?: ExportStore;
  /** Origin used to build download links (the gateway's public address). */
  exportBaseUrl?: string;
  /** Current consent text version per kind (default 1); raising it asks for consent again. */
  consentTextVersions?: Partial<Record<ConsentKind, number>>;
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
  /** Log destination; tests capture it to prove secrets never reach logs. */
  logStream?: Writable;
};

/** Kinds of secret a user can store; values are write-only through the API. */
const SECRET_KINDS = ["llm_key", "google_token"] as const;

const MINUTE = 60_000;
const DAY = 86_400_000;

function fail(reply: FastifyReply, status: number, code: string) {
  return reply.code(status).send({ ok: false, error: { code } });
}

export function createApp(config: AppConfig, deps: IdentityDeps = {}) {
  const app = createServiceApp({
    name: SERVICE_NAME,
    logLevel: config.logLevel,
    nats: deps.nats,
    logStream: deps.logStream,
  });
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

  const invitationView = (i: InvitationRecord) => ({
    id: i.id,
    email: i.email,
    expiresAt: i.expiresAt,
    usedAt: i.usedAt,
    revokedAt: i.revokedAt,
  });

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
    const view = (i: InvitationRecord) => ({ invitation: invitationView(i) });
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
    if ((await store.countUsers()) >= setting("identity.max_users"))
      return fail(reply, 403, "identity.user_limit_reached");
    await store.saveInvitation(invitation);
    await deps.onInvitation?.(email, token);
    await announceInvited(invitation, adminId);
    await auditAdmin(adminId, "invitation.created", invitation.id, null, {
      expiresAt: invitation.expiresAt,
    });
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

  const keyring = config.secretsMasterKey
    ? parseKeyring({
        currentKeyId: config.secretsKeyId,
        masterKey: config.secretsMasterKey,
        previousKeys: config.secretsPreviousKeys,
      })
    : undefined;
  const secretKind = (req: { params: unknown }) => {
    const kind = (req.params as { kind: string }).kind;
    return (SECRET_KINDS as readonly string[]).includes(kind) ? kind : null;
  };

  /** Write-only: the value is encrypted at rest and no endpoint ever returns it (principle 7). */
  app.put("/secrets/:kind", async (req, reply) => {
    const userId = callerId(req.headers);
    if (!userId) return fail(reply, 401, "identity.unauthenticated");
    const kind = secretKind(req);
    if (!kind) return fail(reply, 400, "identity.invalid_secret_kind");
    if (!keyring) return fail(reply, 503, "identity.secrets_unavailable");
    const value = (req.body as { value?: unknown } | undefined)?.value;
    if (typeof value !== "string" || value.length === 0)
      return fail(reply, 400, "identity.invalid_secret");
    const sealed = encryptSecret(value, keyring, `${userId}:${kind}`);
    await store.saveSecret({ userId, kind, ...sealed, updatedAt: now().toISOString() });
    return { ok: true, data: { kind, keyId: sealed.keyId } };
  });

  /** Metadata only: which secrets exist, never their values. */
  app.get("/secrets", async (req, reply) => {
    const userId = callerId(req.headers);
    if (!userId) return fail(reply, 401, "identity.unauthenticated");
    const rows = await store.listSecrets(userId);
    return {
      ok: true,
      data: rows.map((r) => ({ kind: r.kind, keyId: r.keyId, updatedAt: r.updatedAt })),
    };
  });

  app.delete("/secrets/:kind", async (req, reply) => {
    const userId = callerId(req.headers);
    if (!userId) return fail(reply, 401, "identity.unauthenticated");
    const kind = secretKind(req);
    if (!kind) return fail(reply, 400, "identity.invalid_secret_kind");
    await store.deleteSecret(userId, kind);
    return { ok: true, data: { kind } };
  });

  const consents = deps.consentStore ?? createConsentStore();
  const requiredVersion = (kind: ConsentKind) => deps.consentTextVersions?.[kind] ?? 1;
  const consentStatus = async (userId: string, kind: ConsentKind) =>
    evaluateConsent(await consents.find(userId, kind), requiredVersion(kind));
  const consentView = (r: {
    kind: ConsentKind;
    textVersion: number;
    grantedAt: string;
    revokedAt: string | null;
  }) => ({
    kind: r.kind,
    textVersion: r.textVersion,
    grantedAt: r.grantedAt,
    revokedAt: r.revokedAt,
  });

  app.get("/consents", async (req, reply) => {
    const userId = callerId(req.headers);
    if (!userId) return fail(reply, 401, "identity.unauthenticated");
    return { ok: true, data: { consents: (await consents.list(userId)).map(consentView) } };
  });

  app.get("/consents/audit", async (req, reply) => {
    const userId = callerId(req.headers);
    if (!userId) return fail(reply, 401, "identity.unauthenticated");
    return { ok: true, data: { audit: await consents.listAudit(userId) } };
  });

  app.post("/consents", async (req, reply) => {
    const userId = callerId(req.headers);
    if (!userId) return fail(reply, 401, "identity.unauthenticated");
    const body = ConsentRequestSchema.safeParse(req.body);
    if (!body.success) return fail(reply, 400, "identity.invalid_consent");
    const { kind, textVersion } = body.data;
    if (textVersion < requiredVersion(kind))
      return fail(reply, 409, "identity.consent_text_outdated");
    const at = now().toISOString();
    const record = { userId, kind, textVersion, grantedAt: at, revokedAt: null };
    await consents.save(record, {
      id: randomUUID(),
      userId,
      kind,
      action: "granted",
      textVersion,
      at,
    });
    await emit("consent.granted", userId, { kind, textVersion });
    return { ok: true, data: { consent: consentView(record) } };
  });

  app.delete("/consents/:kind", async (req, reply) => {
    const userId = callerId(req.headers);
    if (!userId) return fail(reply, 401, "identity.unauthenticated");
    const kind = ConsentKindSchema.safeParse((req.params as { kind?: string }).kind);
    if (!kind.success) return fail(reply, 400, "identity.invalid_consent");
    const existing = await consents.find(userId, kind.data);
    if (!existing || existing.revokedAt)
      return { ok: true, data: { kind: kind.data, revoked: false } };
    const at = now().toISOString();
    await consents.save(
      { ...existing, revokedAt: at },
      {
        id: randomUUID(),
        userId,
        kind: kind.data,
        action: "revoked",
        textVersion: existing.textVersion,
        at,
      },
    );
    await emit("consent.revoked", userId, { kind: kind.data });
    return { ok: true, data: { kind: kind.data, revoked: true } };
  });

  /** Query for other services (ingest on mail arrival, sync, monitor): is this feature allowed now? */
  app.get("/consents/:kind/check", async (req, reply) => {
    const userId = callerId(req.headers);
    if (!userId) return fail(reply, 401, "identity.unauthenticated");
    const kind = ConsentKindSchema.safeParse((req.params as { kind?: string }).kind);
    if (!kind.success) return fail(reply, 400, "identity.invalid_consent");
    return { ok: true, data: { kind: kind.data, ...(await consentStatus(userId, kind.data)) } };
  });

  /** Query for monitor: the level it may run, given the camera consent. */
  app.post("/consents/supervision-level", async (req, reply) => {
    const userId = callerId(req.headers);
    if (!userId) return fail(reply, 401, "identity.unauthenticated");
    const body = SupervisionLevelSchema.safeParse(
      (req.body as { requested?: unknown } | undefined)?.requested,
    );
    if (!body.success) return fail(reply, 400, "identity.invalid_supervision_level");
    const cameraAvailable = (await consentStatus(userId, "camera")).granted;
    return {
      ok: true,
      data: {
        requested: body.data,
        level: effectiveSupervisionLevel(body.data, cameraAvailable),
        cameraAvailable,
      },
    };
  });

  const exportStore = deps.exportStore ?? createExportStore();
  const exportBase = (deps.exportBaseUrl ?? "http://localhost").replace(/\/+$/, "");

  /** Builds the archive now, keeps it for `identity.export_ttl_hours`, then announces it. */
  app.post("/export", async (req, reply) => {
    const userId = callerId(req.headers);
    if (!userId) return fail(reply, 401, "identity.unauthenticated");
    const user = await store.findUserById(userId);
    if (!user) return fail(reply, 404, "identity.user_not_found");
    const at = now();
    const archive = buildExportArchive({
      user,
      settings: await readSettings(userId),
      settingAudit: await store.listSettingAudit(userId),
      consents: await consents.list(userId),
      consentAudit: await consents.listAudit(userId),
      onboarding: await store.listOnboardingSteps(userId),
      now: at,
    });
    const ttlMs = setting("identity.export_ttl_hours") * 3_600_000;
    const expiresAt = new Date(at.getTime() + ttlMs).toISOString();
    const token = newToken();
    await exportStore.save(hashToken(token), { userId, expiresAt, archive });
    // The link is returned only to the caller; the event carries just the expiry.
    await emit("export.ready", userId, { expiresAt });
    return { ok: true, data: { downloadUrl: `${exportBase}/exports/${token}`, expiresAt } };
  });

  app.get("/exports/:token", async (req, reply) => {
    const userId = callerId(req.headers);
    if (!userId) return fail(reply, 401, "identity.unauthenticated");
    const token = String((req.params as { token?: string }).token ?? "");
    const record = await exportStore.find(hashToken(token));
    if (!record || record.userId !== userId) return fail(reply, 404, "identity.export_not_found");
    if (new Date(record.expiresAt).getTime() <= now().getTime())
      return fail(reply, 410, "identity.export_expired");
    return reply
      .header("content-disposition", 'attachment; filename="my-wife-export.json"')
      .send(record.archive);
  });

  /** Penalty state comes through a port (rules owns it); a failure means "unknown", never "none". */
  async function openPenalties(userId: string) {
    // Fail closed: without a port the ledger is unknown, so nothing may be erased or closed.
    if (!deps.penalties) throw new Error("penalty port is not configured");
    return deps.penalties.listOpen(userId);
  }

  /** Marks an already anonymised account closed and announces it. */
  async function closeAccount(user: UserRecord) {
    await store.saveUser({ ...user, state: "closed" });
    await emit("user.closed", user.id, {});
  }

  /**
   * Deletion (spec 40 section 1 and 6). Personal data is anonymised at once; the account stays
   * `closing` while penalties are suspended or due, and only then is it `closed`.
   */
  app.post("/account/deletion", async (req, reply) => {
    const userId = callerId(req.headers);
    if (!userId) return fail(reply, 401, "identity.unauthenticated");
    const user = await store.findUserById(userId);
    if (!user) return fail(reply, 404, "identity.user_not_found");
    // A request that failed half-way leaves the account `closing`; the repeat finishes the work
    // (already confirmed, and the email may be anonymised by now). Erasing is idempotent.
    const resume = user.state === "closing";
    if (user.state !== "active" && !resume)
      return fail(reply, 409, "identity.deletion_not_allowed");
    const typed = (req.body as { confirmation?: unknown } | undefined)?.confirmation;
    if (
      !resume &&
      (typeof typed !== "string" || typed.trim().toLowerCase() !== user.email.toLowerCase())
    )
      return fail(reply, 400, "identity.deletion_not_confirmed");
    let open;
    try {
      open = await openPenalties(userId);
    } catch (err) {
      app.log.error(
        { err: err instanceof Error ? err.message : "unknown" },
        "penalty lookup failed; nothing was deleted",
      );
      return fail(reply, 503, "identity.penalties_unavailable");
    }
    const closing = { ...user, state: "closing" as const };
    if (!resume) await store.saveUser(closing);
    await store.eraseUserData(userId, anonymisedEmail(userId));
    await consents.deleteAll(userId);
    await exportStore.deleteByUser(userId);
    await emit("user.closing", userId, { reason: "deletion_requested" });
    if (open.length > 0) return { ok: true, data: { state: "closing", exportOffered: true } };
    await closeAccount({ ...closing, email: anonymisedEmail(userId) });
    return { ok: true, data: { state: "closed", exportOffered: true } };
  });

  /** Internal job: closes every closing account whose penalties are all settled. */
  app.post("/jobs/closing", async () => {
    let closed = 0;
    for (const user of await store.listUsersByState("closing")) {
      try {
        if ((await openPenalties(user.id)).length > 0) continue;
      } catch {
        continue;
      }
      await closeAccount(user);
      closed++;
    }
    return { ok: true, data: { closed } };
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

  // ---- Admin incidents (spec 50 section 3) ----
  const incidents = deps.incidentStore ?? createIncidentStore();

  const adminId = (headers: Record<string, unknown>) =>
    headers["x-user-role"] === "admin" ? callerId(headers) : null;

  async function record(
    actor: string,
    action: string,
    before: Incident | null,
    after: Incident,
  ): Promise<void> {
    const snap = (i: Incident | null) =>
      i && {
        state: i.state,
        startsAt: i.startsAt,
        endsAt: i.endsAt,
        scope: i.scope,
        reason: i.reason,
      };
    await incidents.save(after, {
      id: randomUUID(),
      actorId: actor,
      action,
      targetId: after.id,
      before: snap(before),
      after: snap(after),
      at: now().toISOString(),
    });
  }

  app.post("/admin/incidents", async (req, reply) => {
    const admin = adminId(req.headers);
    if (!admin) return fail(reply, 403, "identity.forbidden");
    const parsed = DeclareIncidentRequestSchema.safeParse(req.body);
    const reason = parsed.success ? parsed.data.reason.trim() : "";
    if (!parsed.success || !reason) return fail(reply, 400, "identity.incident_invalid");
    const { startsAt, endsAt, scope } = parsed.data;
    if (endsAt !== null && Date.parse(endsAt) < Date.parse(startsAt))
      return fail(reply, 400, "identity.incident_invalid");
    const incident: Incident = {
      id: randomUUID(),
      state: endsAt === null ? "active" : "ended",
      startsAt,
      endsAt,
      scope,
      reason,
    };
    await record(admin, "incident.declared", null, incident);
    await emit("incident.declared", admin, { incidentId: incident.id, startsAt, endsAt, scope });
    return reply.code(201).send({ ok: true, data: { incident } });
  });

  app.get("/admin/incidents", async (req, reply) => {
    if (!adminId(req.headers)) return fail(reply, 403, "identity.forbidden");
    return { ok: true, data: { incidents: await incidents.list() } };
  });

  app.get("/admin/audit", async (req, reply) => {
    if (!adminId(req.headers)) return fail(reply, 403, "identity.forbidden");
    return { ok: true, data: { entries: await incidents.listAudit() } };
  });

  app.post("/admin/incidents/:id/end", async (req, reply) => {
    const admin = adminId(req.headers);
    if (!admin) return fail(reply, 403, "identity.forbidden");
    const before = await incidents.find((req.params as { id: string }).id);
    if (!before) return fail(reply, 404, "identity.incident_not_found");
    if (before.state !== "active") return fail(reply, 409, "identity.incident_not_active");
    const asked = (req.body as { endsAt?: unknown } | undefined)?.endsAt;
    const parsedEnd = asked === undefined ? undefined : IsoDateTimeSchema.safeParse(asked);
    if (parsedEnd && !parsedEnd.success) return fail(reply, 400, "identity.incident_invalid");
    const endsAt = parsedEnd?.data ?? now().toISOString();
    if (Date.parse(endsAt) < Date.parse(before.startsAt))
      return fail(reply, 400, "identity.incident_invalid");
    const after: Incident = { ...before, state: "ended", endsAt: new Date(endsAt).toISOString() };
    await record(admin, "incident.ended", before, after);
    await emit("incident.ended", admin, { incidentId: after.id, endsAt: after.endsAt as string });
    return { ok: true, data: { incident: after } };
  });

  app.post("/admin/incidents/:id/cancel", async (req, reply) => {
    const admin = adminId(req.headers);
    if (!admin) return fail(reply, 403, "identity.forbidden");
    const before = await incidents.find((req.params as { id: string }).id);
    if (!before) return fail(reply, 404, "identity.incident_not_found");
    if (before.state === "cancelled") return fail(reply, 409, "identity.incident_cancelled");
    const after: Incident = { ...before, state: "cancelled" };
    await record(admin, "incident.cancelled", before, after);
    await emit("incident.cancelled", admin, { incidentId: after.id });
    return { ok: true, data: { incident: after } };
  });

  /** An affected user (or an internal reader such as the weekly report) reads the reason. */
  app.get("/incidents/:id", async (req, reply) => {
    const userId = callerId(req.headers);
    if (!userId) return fail(reply, 401, "identity.unauthenticated");
    const incident = await incidents.find((req.params as { id: string }).id);
    if (!incident || !incidentCoversUser(incident, userId))
      return fail(reply, 404, "identity.incident_not_found");
    return { ok: true, data: { incident } };
  });

  // ---- Admin invitations and sender map (spec 50 section 2) ----
  async function auditAdmin(
    actor: string,
    action: string,
    targetId: string,
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
  ) {
    await incidents.addAudit({
      id: randomUUID(),
      actorId: actor,
      action,
      targetId,
      before,
      after,
      at: now().toISOString(),
    });
  }

  app.get("/admin/invitations", async (req, reply) => {
    if (!adminId(req.headers)) return fail(reply, 403, "identity.forbidden");
    const all = await store.listInvitations();
    return { ok: true, data: { invitations: all.map(invitationView) } };
  });

  app.post("/admin/invitations/:id/revoke", async (req, reply) => {
    const admin = adminId(req.headers);
    if (!admin) return fail(reply, 403, "identity.forbidden");
    const invitation = await store.findInvitationById((req.params as { id: string }).id);
    if (!invitation) return fail(reply, 404, "identity.invitation_not_found");
    if (invitation.usedAt) return fail(reply, 409, "identity.invitation_used");
    if (invitation.revokedAt) return { ok: true, data: { invitation: invitationView(invitation) } };
    const revoked = { ...invitation, revokedAt: now().toISOString() };
    await store.saveInvitation(revoked);
    await auditAdmin(
      admin,
      "invitation.revoked",
      revoked.id,
      { revokedAt: null },
      { revokedAt: revoked.revokedAt },
    );
    await emit("invitation.revoked", admin, { invitationId: revoked.id });
    return { ok: true, data: { invitation: invitationView(revoked) } };
  });

  // ---- Feature flags per user (spec 50 section 2) ----
  const featureFlags = deps.featureFlagStore ?? createFeatureFlagStore();

  /** Admin switch. Readers query live, so a change applies on the next request. */
  app.put("/admin/feature-flags", async (req, reply) => {
    const admin = adminId(req.headers);
    if (!admin) return fail(reply, 403, "identity.forbidden");
    const parsed = SetFeatureFlagRequestSchema.safeParse(req.body);
    if (!parsed.success) return fail(reply, 400, "identity.feature_flag_invalid");
    const { userId, flag, enabled } = parsed.data;
    const was = (await featureFlags.get(userId, flag)) ?? true;
    await featureFlags.set(userId, flag, enabled);
    await auditAdmin(
      admin,
      "feature_flag.changed",
      userId,
      { flag, enabled: was },
      { flag, enabled },
    );
    await emit("feature_flag.changed", userId, { flag, enabled });
    return { ok: true, data: { flag: { userId, flag, enabled } } };
  });

  /** Query for other services and the web: may this caller use the feature now? */
  app.get("/feature-flags/:flag/check", async (req, reply) => {
    const userId = callerId(req.headers);
    if (!userId) return fail(reply, 401, "identity.unauthenticated");
    const flag = FeatureFlagSchema.safeParse((req.params as { flag?: string }).flag);
    if (!flag.success) return fail(reply, 400, "identity.feature_flag_invalid");
    const enabled = (await featureFlags.get(userId, flag.data)) ?? true;
    return {
      ok: true,
      data: {
        flag: flag.data,
        enabled,
        ...(enabled ? {} : { noticeKey: featureDisabledNoticeKey(flag.data) }),
      },
    };
  });

  app.get("/feature-flags", async (req, reply) => {
    const userId = callerId(req.headers);
    if (!userId) return fail(reply, 401, "identity.unauthenticated");
    const flags = await featureFlags.list(userId);
    const notices = FeatureFlagSchema.options
      .filter((f) => flags[f] === false)
      .map(featureDisabledNoticeKey);
    return { ok: true, data: { flags, notices } };
  });

  const senderMap = deps.senderMapStore ?? createSenderMapStore();

  /** Read by ingest and by users choosing their bank; any identified caller. */
  app.get("/sender-map", async (req, reply) => {
    if (!callerId(req.headers)) return fail(reply, 401, "identity.unauthenticated");
    return { ok: true, data: { entries: await senderMap.list() } };
  });

  app.put("/admin/sender-map", async (req, reply) => {
    const admin = adminId(req.headers);
    if (!admin) return fail(reply, 403, "identity.forbidden");
    const parsed = SenderMapEntryRequestSchema.safeParse(req.body);
    if (!parsed.success) return fail(reply, 400, "identity.sender_map_invalid");
    const entry: SenderMapEntry = {
      senderKey: parsed.data.senderKey.trim(),
      senderAddress: parsed.data.senderAddress.trim().toLowerCase(),
      dkimDomain: parsed.data.dkimDomain.trim().toLowerCase(),
    };
    if (!entry.senderKey || !entry.senderAddress || !entry.dkimDomain)
      return fail(reply, 400, "identity.sender_map_invalid");
    const before = await senderMap.find(entry.senderKey);
    await senderMap.save(entry);
    await auditAdmin(admin, "sender_map.saved", entry.senderKey, before ?? null, { ...entry });
    await emit("sender_map.changed", admin, {
      senderKey: entry.senderKey,
      removed: false,
      on: now().toISOString().slice(0, 10),
    });
    return before
      ? { ok: true, data: { entry } }
      : reply.code(201).send({ ok: true, data: { entry } });
  });

  app.delete("/admin/sender-map/:senderKey", async (req, reply) => {
    const admin = adminId(req.headers);
    if (!admin) return fail(reply, 403, "identity.forbidden");
    const key = (req.params as { senderKey: string }).senderKey;
    const before = await senderMap.find(key);
    if (!before) return fail(reply, 404, "identity.sender_map_not_found");
    await senderMap.remove(key);
    await auditAdmin(admin, "sender_map.removed", key, { ...before }, null);
    await emit("sender_map.changed", admin, {
      senderKey: key,
      removed: true,
      on: now().toISOString().slice(0, 10),
    });
    return { ok: true, data: { removed: key } };
  });

  return app;
}
