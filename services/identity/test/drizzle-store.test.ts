import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "@my-wife/service-kit";
import { createDrizzleStore } from "../src/drizzle-store";
import { migrate } from "../src/migrate";

const url = process.env.DATABASE_URL;

// Runs against the shared stack with a per-branch database; skipped only without DATABASE_URL.
describe.skipIf(!url)("drizzle store (PostgreSQL)", () => {
  const handle = createDb(url ?? "postgres://unused");
  const store = createDrizzleStore(handle.db);

  beforeAll(async () => {
    await handle.db.execute(sql.raw("DROP SCHEMA IF EXISTS identity CASCADE"));
    await migrate(handle.db);
  });
  afterAll(async () => {
    await handle.close();
  });

  it("applies migrations once", async () => {
    await expect(migrate(handle.db)).resolves.toEqual([]);
  });

  it("round-trips users and refuses a duplicate email", async () => {
    const user = {
      id: "u1",
      email: "a@x.com",
      state: "active" as const,
      role: "user" as const,
      locale: "vi" as const,
      lastSeenAt: null,
      activatedEventAt: null,
    };
    expect(await store.insertUser(user)).toBe(true);
    expect(await store.insertUser({ ...user, id: "u2" })).toBe(false);
    expect(await store.findUserByEmail("a@x.com")).toEqual(user);
    expect(await store.countUsers()).toBe(1);
    const marked = { ...user, activatedEventAt: "2026-01-01T00:00:00.000Z" };
    await store.saveUser(marked);
    expect(await store.findUserById("u1")).toEqual(marked);
  });

  it("round-trips invitations and finds only open ones", async () => {
    const inv = {
      id: "i1",
      email: "b@x.com",
      tokenHash: "h1",
      expiresAt: "2026-01-08T00:00:00.000Z",
      usedAt: null,
      revokedAt: null,
      invitedEventAt: null,
    };
    await store.saveInvitation(inv);
    expect(await store.findInvitationByTokenHash("h1")).toEqual(inv);
    const early = new Date("2026-01-01T00:00:00Z");
    const late = new Date("2026-01-09T00:00:00Z");
    expect(await store.findOpenInvitationByEmail("b@x.com", early)).toEqual(inv);
    expect(await store.findOpenInvitationByEmail("b@x.com", late)).toBeUndefined();
  });

  it("round-trips login tokens", async () => {
    const t = {
      tokenHash: "t1",
      email: "a@x.com",
      expiresAt: "2026-01-01T00:15:00.000Z",
      usedAt: null,
    };
    await store.saveLoginToken(t);
    expect(await store.findLoginToken("t1")).toEqual(t);
  });

  it("round-trips and revokes sessions", async () => {
    const s = {
      id: "s1",
      userId: "u1",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-31T00:00:00.000Z",
      revokedAt: null,
    };
    await store.saveSession(s);
    expect(await store.findSession("s1")).toEqual(s);
    await store.revokeSession("s1", "2026-01-02T00:00:00.000Z");
    expect((await store.listSessions("u1"))[0]!.revokedAt).toBe("2026-01-02T00:00:00.000Z");
  });
});
