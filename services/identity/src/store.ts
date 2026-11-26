export type UserRecord = {
  id: string;
  email: string;
  state: "invited" | "active" | "closing" | "closed" | "suspended";
  role: "user" | "admin";
  locale: "vi" | "en";
  lastSeenAt: string | null;
};

export type InvitationRecord = {
  id: string;
  email: string;
  tokenHash: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
};

export type LoginTokenRecord = {
  tokenHash: string;
  email: string;
  expiresAt: string;
  usedAt: string | null;
};

/** Persistence port. The Drizzle implementation (identity schema) replaces the in-memory one. */
export interface IdentityStore {
  findUserByEmail(email: string): Promise<UserRecord | undefined>;
  findUserById(id: string): Promise<UserRecord | undefined>;
  countUsers(): Promise<number>;
  saveUser(user: UserRecord): Promise<void>;
  saveInvitation(invitation: InvitationRecord): Promise<void>;
  findInvitationByTokenHash(hash: string): Promise<InvitationRecord | undefined>;
  findOpenInvitationByEmail(email: string, now: Date): Promise<InvitationRecord | undefined>;
  saveLoginToken(token: LoginTokenRecord): Promise<void>;
  findLoginToken(hash: string): Promise<LoginTokenRecord | undefined>;
}

export function createMemoryStore(): IdentityStore {
  const users = new Map<string, UserRecord>();
  const invitations = new Map<string, InvitationRecord>();
  const loginTokens = new Map<string, LoginTokenRecord>();
  return {
    async findUserByEmail(email) {
      return [...users.values()].find((u) => u.email === email);
    },
    async findUserById(id) {
      return users.get(id);
    },
    async countUsers() {
      return users.size;
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
  };
}
