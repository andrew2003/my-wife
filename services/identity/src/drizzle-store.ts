import { and, asc, count, eq, gt, isNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type {
  IdentityStore,
  InvitationRecord,
  SessionRecord,
  SettingAuditRecord,
  UserRecord,
} from "./store";
import {
  invitations,
  loginTokens,
  onboardingSteps,
  sessions,
  settingAudit,
  userSettings,
  users,
} from "./schema";

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const date = (s: string | null): Date | null => (s ? new Date(s) : null);

const toUser = (r: typeof users.$inferSelect): UserRecord => ({
  ...r,
  locale: r.locale as UserRecord["locale"],
  lastSeenAt: iso(r.lastSeenAt),
  activatedEventAt: iso(r.activatedEventAt),
});

const toUserRow = (u: UserRecord) => ({
  ...u,
  lastSeenAt: date(u.lastSeenAt),
  activatedEventAt: date(u.activatedEventAt),
});

const toInvitation = (r: typeof invitations.$inferSelect): InvitationRecord => ({
  ...r,
  expiresAt: r.expiresAt.toISOString(),
  usedAt: iso(r.usedAt),
  revokedAt: iso(r.revokedAt),
  invitedEventAt: iso(r.invitedEventAt),
});

const toSession = (r: typeof sessions.$inferSelect): SessionRecord => ({
  ...r,
  createdAt: r.createdAt.toISOString(),
  expiresAt: r.expiresAt.toISOString(),
  revokedAt: iso(r.revokedAt),
});

/** PostgreSQL implementation over the `identity` schema (SQL in `drizzle/`). */
export function createDrizzleStore(db: NodePgDatabase): IdentityStore {
  return {
    async findOnboardingStep(userId, step) {
      const [r] = await db
        .select()
        .from(onboardingSteps)
        .where(and(eq(onboardingSteps.userId, userId), eq(onboardingSteps.step, step)));
      return r && { ...r, completedAt: r.completedAt.toISOString(), eventAt: iso(r.eventAt) };
    },
    async saveOnboardingStep(rec) {
      const row = { ...rec, completedAt: new Date(rec.completedAt), eventAt: date(rec.eventAt) };
      await db
        .insert(onboardingSteps)
        .values(row)
        .onConflictDoUpdate({
          target: [onboardingSteps.userId, onboardingSteps.step],
          set: { eventAt: row.eventAt },
        });
    },
    async getSettingOverrides(userId) {
      const rows = await db.select().from(userSettings).where(eq(userSettings.userId, userId));
      return Object.fromEntries(rows.map((r) => [r.key, r.value]));
    },
    async saveSetting(userId, key, value, entry) {
      await this.saveSettings(userId, [{ key, value, audit: entry }]);
    },
    async saveSettings(userId, changes) {
      await db.transaction(async (tx) => {
        for (const { key, value, audit } of changes) {
          const updatedAt = new Date(audit.at);
          await tx
            .insert(userSettings)
            .values({ userId, key, value, updatedAt })
            .onConflictDoUpdate({
              target: [userSettings.userId, userSettings.key],
              set: { value, updatedAt },
            });
          await tx.insert(settingAudit).values({ ...audit, at: updatedAt });
        }
      });
    },
    async listSettingAudit(userId) {
      const rows = await db
        .select()
        .from(settingAudit)
        .where(eq(settingAudit.userId, userId))
        .orderBy(asc(settingAudit.at));
      return rows.map((r): SettingAuditRecord => ({ ...r, at: r.at.toISOString() }));
    },
    async findUserByEmail(email) {
      const [r] = await db.select().from(users).where(eq(users.email, email));
      return r && toUser(r);
    },
    async findUserById(id) {
      const [r] = await db.select().from(users).where(eq(users.id, id));
      return r && toUser(r);
    },
    async countUsers() {
      const [r] = await db.select({ n: count() }).from(users);
      return r?.n ?? 0;
    },
    async insertUser(user) {
      const rows = await db
        .insert(users)
        .values(toUserRow(user))
        .onConflictDoNothing()
        .returning({ id: users.id });
      return rows.length > 0;
    },
    async saveUser(user) {
      const row = toUserRow(user);
      await db.insert(users).values(row).onConflictDoUpdate({ target: users.id, set: row });
    },
    async saveInvitation(inv) {
      const row = {
        ...inv,
        expiresAt: new Date(inv.expiresAt),
        usedAt: date(inv.usedAt),
        revokedAt: date(inv.revokedAt),
        invitedEventAt: date(inv.invitedEventAt),
      };
      await db
        .insert(invitations)
        .values(row)
        .onConflictDoUpdate({ target: invitations.id, set: row });
    },
    async findInvitationByTokenHash(hash) {
      const [r] = await db.select().from(invitations).where(eq(invitations.tokenHash, hash));
      return r && toInvitation(r);
    },
    async findOpenInvitationByEmail(email, now) {
      const [r] = await db
        .select()
        .from(invitations)
        .where(
          and(
            eq(invitations.email, email),
            isNull(invitations.usedAt),
            isNull(invitations.revokedAt),
            gt(invitations.expiresAt, now),
          ),
        );
      return r && toInvitation(r);
    },
    async saveLoginToken(t) {
      const row = { ...t, expiresAt: new Date(t.expiresAt), usedAt: date(t.usedAt) };
      await db
        .insert(loginTokens)
        .values(row)
        .onConflictDoUpdate({ target: loginTokens.tokenHash, set: row });
    },
    async findLoginToken(hash) {
      const [r] = await db.select().from(loginTokens).where(eq(loginTokens.tokenHash, hash));
      return r && { ...r, expiresAt: r.expiresAt.toISOString(), usedAt: iso(r.usedAt) };
    },
    async saveSession(s) {
      await db.insert(sessions).values({
        ...s,
        createdAt: new Date(s.createdAt),
        expiresAt: new Date(s.expiresAt),
        revokedAt: date(s.revokedAt),
      });
    },
    async findSession(id) {
      const [r] = await db.select().from(sessions).where(eq(sessions.id, id));
      return r && toSession(r);
    },
    async listSessions(userId) {
      return (await db.select().from(sessions).where(eq(sessions.userId, userId))).map(toSession);
    },
    async revokeSession(id, at) {
      await db
        .update(sessions)
        .set({ revokedAt: new Date(at) })
        .where(eq(sessions.id, id));
    },
  };
}
