import { and, asc, count, eq, gt, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type {
  IdentityStore,
  InvitationRecord,
  SessionRecord,
  SettingAuditRecord,
  SecretRecord,
  UserRecord,
} from "./store";
import {
  invitations,
  loginTokens,
  onboardingSteps,
  secrets,
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

type Tx = Parameters<Parameters<NodePgDatabase["transaction"]>[0]>[0];

/**
 * PostgreSQL implementation over the `identity` schema (SQL in `drizzle/`).
 * Tables with a `user_id` are reached through `scoped`: the transaction drops to the
 * non-bypassing `identity_app` role and sets `app.user_id`, so row-level security
 * confines every statement to that user (spec 40 section 5).
 */
export function createDrizzleStore(rootDb: NodePgDatabase): IdentityStore {
  const scoped = <T>(userId: string, fn: (db: Tx) => Promise<T>): Promise<T> =>
    rootDb.transaction(async (tx) => {
      await tx.execute(sql.raw("SET LOCAL ROLE identity_app"));
      await tx.execute(sql`SELECT set_config('app.user_id', ${userId}, true)`);
      return fn(tx);
    });
  const db = rootDb;
  return {
    async listUsersByState(state) {
      return (await db.select().from(users).where(eq(users.state, state))).map(toUser);
    },
    async eraseUserData(userId, anonymisedEmail) {
      const [user] = await db.select().from(users).where(eq(users.id, userId));
      if (!user) return;
      await scoped(userId, async (tx) => {
        await tx.delete(secrets).where(eq(secrets.userId, userId));
        await tx.delete(onboardingSteps).where(eq(onboardingSteps.userId, userId));
        await tx.delete(userSettings).where(eq(userSettings.userId, userId));
        await tx.delete(settingAudit).where(eq(settingAudit.userId, userId));
      });
      await db.transaction(async (tx) => {
        await tx.delete(sessions).where(eq(sessions.userId, userId));
        await tx.delete(invitations).where(eq(invitations.email, user.email));
        await tx.delete(loginTokens).where(eq(loginTokens.email, user.email));
        await tx
          .update(users)
          .set({ email: anonymisedEmail, lastSeenAt: null })
          .where(eq(users.id, userId));
      });
    },
    async saveSecret(r: SecretRecord) {
      const row = { ...r, updatedAt: new Date(r.updatedAt) };
      await scoped(r.userId, (tx) =>
        tx
          .insert(secrets)
          .values(row)
          .onConflictDoUpdate({
            target: [secrets.userId, secrets.kind],
            set: { keyId: row.keyId, payload: row.payload, updatedAt: row.updatedAt },
          }),
      );
    },
    async findSecret(userId, kind) {
      const [r] = await scoped(userId, (tx) =>
        tx
          .select()
          .from(secrets)
          .where(and(eq(secrets.userId, userId), eq(secrets.kind, kind))),
      );
      return r && { ...r, updatedAt: r.updatedAt.toISOString() };
    },
    async listSecrets(userId) {
      const rows = await scoped(userId, (tx) =>
        tx.select().from(secrets).where(eq(secrets.userId, userId)),
      );
      return rows.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() }));
    },
    async deleteSecret(userId, kind) {
      await scoped(userId, (tx) =>
        tx.delete(secrets).where(and(eq(secrets.userId, userId), eq(secrets.kind, kind))),
      );
    },
    async findOnboardingStep(userId, step) {
      const [r] = await scoped(userId, (tx) =>
        tx
          .select()
          .from(onboardingSteps)
          .where(and(eq(onboardingSteps.userId, userId), eq(onboardingSteps.step, step))),
      );
      return r && { ...r, completedAt: r.completedAt.toISOString(), eventAt: iso(r.eventAt) };
    },
    async listOnboardingSteps(userId) {
      const rows = await scoped(userId, (tx) =>
        tx.select().from(onboardingSteps).where(eq(onboardingSteps.userId, userId)),
      );
      return rows.map((r) => ({
        ...r,
        completedAt: r.completedAt.toISOString(),
        eventAt: iso(r.eventAt),
      }));
    },
    async saveOnboardingStep(rec) {
      const row = { ...rec, completedAt: new Date(rec.completedAt), eventAt: date(rec.eventAt) };
      await scoped(rec.userId, (tx) =>
        tx
          .insert(onboardingSteps)
          .values(row)
          .onConflictDoUpdate({
            target: [onboardingSteps.userId, onboardingSteps.step],
            set: { eventAt: row.eventAt },
          }),
      );
    },
    async getSettingOverrides(userId) {
      const rows = await scoped(userId, (tx) =>
        tx.select().from(userSettings).where(eq(userSettings.userId, userId)),
      );
      return Object.fromEntries(rows.map((r) => [r.key, r.value]));
    },
    async saveSetting(userId, key, value, entry) {
      await this.saveSettings(userId, [{ key, value, audit: entry }]);
    },
    async saveSettings(userId, changes) {
      await scoped(userId, async (tx) => {
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
      const rows = await scoped(userId, (tx) =>
        tx
          .select()
          .from(settingAudit)
          .where(eq(settingAudit.userId, userId))
          .orderBy(asc(settingAudit.at)),
      );
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
