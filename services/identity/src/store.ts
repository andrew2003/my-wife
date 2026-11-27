export type UserRecord = {
  id: string;
  email: string;
  state: "invited" | "active" | "closing" | "closed" | "suspended";
  role: "user" | "admin";
  locale: "vi" | "en";
  lastSeenAt: string | null;
  /** Set once user.activated was published; unset means the event is still owed. */
  activatedEventAt: string | null;
};

export type InvitationRecord = {
  id: string;
  email: string;
  tokenHash: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
  /** Set once user.invited was published; unset means the event is still owed. */
  invitedEventAt: string | null;
};

export type LoginTokenRecord = {
  tokenHash: string;
  email: string;
  expiresAt: string;
  usedAt: string | null;
};

/** A persisted sign-in. The raw token is never stored; it carries only this id. */
export type SessionRecord = {
  id: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
};

/** One change of a user setting; the history is visible to the user (spec 40 section 2). */
export type SettingAuditRecord = {
  id: string;
  userId: string;
  actorId: string;
  key: string;
  before: unknown;
  after: unknown;
  at: string;
};

export type SettingChange = { key: string; value: unknown; audit: SettingAuditRecord };

/** A finished onboarding step; `eventAt` unset means onboarding.step_completed is still owed. */
export type OnboardingStepRecord = {
  userId: string;
  step: string;
  skipped: boolean;
  completedAt: string;
  eventAt: string | null;
};

/** An encrypted user key or token. The plaintext never reaches the store. */
export type SecretRecord = {
  userId: string;
  kind: string;
  keyId: string;
  payload: string;
  updatedAt: string;
};

/** Persistence port. The Drizzle implementation (identity schema) replaces the in-memory one. */
export interface IdentityStore {
  findUserByEmail(email: string): Promise<UserRecord | undefined>;
  findUserById(id: string): Promise<UserRecord | undefined>;
  countUsers(): Promise<number>;
  /** Inserts a new user; false when the email is already taken (concurrent first sign-in). */
  insertUser(user: UserRecord): Promise<boolean>;
  saveUser(user: UserRecord): Promise<void>;
  saveInvitation(invitation: InvitationRecord): Promise<void>;
  findInvitationByTokenHash(hash: string): Promise<InvitationRecord | undefined>;
  findOpenInvitationByEmail(email: string, now: Date): Promise<InvitationRecord | undefined>;
  saveLoginToken(token: LoginTokenRecord): Promise<void>;
  findLoginToken(hash: string): Promise<LoginTokenRecord | undefined>;
  saveSession(session: SessionRecord): Promise<void>;
  findSession(id: string): Promise<SessionRecord | undefined>;
  listSessions(userId: string): Promise<SessionRecord[]>;
  revokeSession(id: string, at: string): Promise<void>;
  /** Only values the user changed; missing keys fall back to the registry default. */
  getSettingOverrides(userId: string): Promise<Record<string, unknown>>;
  /** Saves the value and its audit entry together. */
  saveSetting(
    userId: string,
    key: string,
    value: unknown,
    audit: SettingAuditRecord,
  ): Promise<void>;
  /** Saves several settings with their audit entries all together or not at all. */
  saveSettings(userId: string, changes: SettingChange[]): Promise<void>;
  listSettingAudit(userId: string): Promise<SettingAuditRecord[]>;
  findOnboardingStep(userId: string, step: string): Promise<OnboardingStepRecord | undefined>;
  listOnboardingSteps(userId: string): Promise<OnboardingStepRecord[]>;
  saveOnboardingStep(record: OnboardingStepRecord): Promise<void>;
  saveSecret(record: SecretRecord): Promise<void>;
  findSecret(userId: string, kind: string): Promise<SecretRecord | undefined>;
  listSecrets(userId: string): Promise<SecretRecord[]>;
  deleteSecret(userId: string, kind: string): Promise<void>;
  listUsersByState(state: UserRecord["state"]): Promise<UserRecord[]>;
  /**
   * Account deletion: removes the user's settings, setting history, onboarding steps, secrets and
   * sessions, plus invitations and login tokens for the old email, and replaces the email on the
   * user row. The row itself stays (id and state) so the account state can still be read.
   */
  eraseUserData(userId: string, anonymisedEmail: string): Promise<void>;
}

export function createMemoryStore(): IdentityStore {
  const users = new Map<string, UserRecord>();
  const invitations = new Map<string, InvitationRecord>();
  const loginTokens = new Map<string, LoginTokenRecord>();
  const sessions = new Map<string, SessionRecord>();
  const settings = new Map<string, Record<string, unknown>>();
  const audit: SettingAuditRecord[] = [];
  const steps = new Map<string, OnboardingStepRecord>();
  const secrets = new Map<string, SecretRecord>();
  return {
    async listUsersByState(state) {
      return [...users.values()].filter((u) => u.state === state);
    },
    async eraseUserData(userId, anonymisedEmail) {
      const user = users.get(userId);
      if (!user) return;
      for (const [k, v] of invitations) if (v.email === user.email) invitations.delete(k);
      for (const [k, v] of loginTokens) if (v.email === user.email) loginTokens.delete(k);
      for (const [k, v] of sessions) if (v.userId === userId) sessions.delete(k);
      for (const [k, v] of steps) if (v.userId === userId) steps.delete(k);
      for (const [k, v] of secrets) if (v.userId === userId) secrets.delete(k);
      settings.delete(userId);
      for (let i = audit.length - 1; i >= 0; i--)
        if (audit[i]?.userId === userId) audit.splice(i, 1);
      users.set(userId, { ...user, email: anonymisedEmail, lastSeenAt: null });
    },
    async saveSecret(r) {
      secrets.set(`${r.userId}:${r.kind}`, r);
    },
    async findSecret(userId, kind) {
      return secrets.get(`${userId}:${kind}`);
    },
    async listSecrets(userId) {
      return [...secrets.values()].filter((r) => r.userId === userId);
    },
    async deleteSecret(userId, kind) {
      secrets.delete(`${userId}:${kind}`);
    },
    async findOnboardingStep(userId, step) {
      return steps.get(`${userId}:${step}`);
    },
    async listOnboardingSteps(userId) {
      return [...steps.values()].filter((s) => s.userId === userId);
    },
    async saveOnboardingStep(record) {
      steps.set(`${record.userId}:${record.step}`, record);
    },
    async getSettingOverrides(userId) {
      return { ...settings.get(userId) };
    },
    async saveSetting(userId, key, value, entry) {
      settings.set(userId, { ...settings.get(userId), [key]: value });
      audit.push(entry);
    },
    async saveSettings(userId, changes) {
      settings.set(userId, {
        ...settings.get(userId),
        ...Object.fromEntries(changes.map((c) => [c.key, c.value])),
      });
      audit.push(...changes.map((c) => c.audit));
    },
    async listSettingAudit(userId) {
      return audit.filter((a) => a.userId === userId);
    },
    async findUserByEmail(email) {
      return [...users.values()].find((u) => u.email === email);
    },
    async findUserById(id) {
      return users.get(id);
    },
    async countUsers() {
      return users.size;
    },
    async insertUser(user) {
      if ([...users.values()].some((u) => u.email === user.email)) return false;
      users.set(user.id, user);
      return true;
    },
    async saveUser(user) {
      users.set(user.id, user);
    },
    async saveInvitation(inv) {
      invitations.set(inv.id, inv);
    },
    async findInvitationByTokenHash(hash) {
      return [...invitations.values()].find((i) => i.tokenHash === hash);
    },
    async findOpenInvitationByEmail(email, now) {
      return [...invitations.values()].find(
        (i) => i.email === email && !i.usedAt && !i.revokedAt && new Date(i.expiresAt) > now,
      );
    },
    async saveLoginToken(t) {
      loginTokens.set(t.tokenHash, t);
    },
    async findLoginToken(hash) {
      return loginTokens.get(hash);
    },
    async saveSession(session) {
      sessions.set(session.id, session);
    },
    async findSession(id) {
      return sessions.get(id);
    },
    async listSessions(userId) {
      return [...sessions.values()].filter((s) => s.userId === userId);
    },
    async revokeSession(id, at) {
      const s = sessions.get(id);
      if (s) sessions.set(id, { ...s, revokedAt: at });
    },
  };
}
