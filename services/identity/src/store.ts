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
  listSettingAudit(userId: string): Promise<SettingAuditRecord[]>;
}

export function createMemoryStore(): IdentityStore {
  const users = new Map<string, UserRecord>();
  const invitations = new Map<string, InvitationRecord>();
  const loginTokens = new Map<string, LoginTokenRecord>();
  const sessions = new Map<string, SessionRecord>();
  const settings = new Map<string, Record<string, unknown>>();
  const audit: SettingAuditRecord[] = [];
  return {
    async getSettingOverrides(userId) {
      return { ...settings.get(userId) };
    },
    async saveSetting(userId, key, value, entry) {
      settings.set(userId, { ...settings.get(userId), [key]: value });
      audit.push(entry);
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
