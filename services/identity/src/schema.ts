import { index, jsonb, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { serviceSchema } from "@my-wife/service-kit";

const identity = serviceSchema("identity");

export const userState = identity.enum("user_state", [
  "invited",
  "active",
  "closing",
  "closed",
  "suspended",
]);
export const userRole = identity.enum("user_role", ["user", "admin"]);

export const users = identity.table(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    state: userState("state").notNull(),
    role: userRole("role").notNull(),
    locale: text("locale").notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    activatedEventAt: timestamp("activated_event_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("users_email_idx").on(t.email)],
);

export const invitations = identity.table(
  "invitations",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    invitedEventAt: timestamp("invited_event_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("invitations_token_hash_idx").on(t.tokenHash),
    index("invitations_email_idx").on(t.email),
  ],
);

export const loginTokens = identity.table("login_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  email: text("email").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
});

export const sessions = identity.table(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const userSettings = identity.table(
  "user_settings",
  {
    userId: text("user_id").notNull(),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);

export const settingAudit = identity.table(
  "setting_audit",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    actorId: text("actor_id").notNull(),
    key: text("key").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    at: timestamp("at", { withTimezone: true }).notNull(),
  },
  (t) => [index("setting_audit_user_idx").on(t.userId, t.at)],
);
