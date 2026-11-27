import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "@my-wife/service-kit";
import { createDrizzleStore } from "../src/drizzle-store";
import { migrate } from "../src/migrate";
import { encryptSecret, parseKeyring } from "../src/secrets-crypto";

const url = process.env.DATABASE_URL;
const NOW = "2026-01-01T00:00:00.000Z";

// Needs the shared stack with a per-branch database; skipped only without DATABASE_URL.
describe.skipIf(!url)("row-level security (PostgreSQL)", () => {
  const handle = createDb(url ?? "postgres://unused");
  const store = createDrizzleStore(handle.db);
  const ring = parseKeyring({
    currentKeyId: "k1",
    masterKey: Buffer.alloc(32, 3).toString("base64"),
  });

  beforeAll(async () => {
    await handle.db.execute(sql.raw("DROP SCHEMA IF EXISTS identity CASCADE"));
    await migrate(handle.db);
    for (const u of ["ua", "ub"]) {
      await store.saveSetting(u, "k", u, {
        id: `au-${u}`,
        userId: u,
        actorId: u,
        key: "k",
        before: null,
        after: u,
        at: NOW,
      });
      await store.saveOnboardingStep({
        userId: u,
        step: "tour",
        skipped: false,
        completedAt: NOW,
        eventAt: null,
      });
      await store.saveSecret({
        userId: u,
        kind: "llm_key",
        ...encryptSecret("s-" + u, ring, `${u}:llm_key`),
        updatedAt: NOW,
      });
    }
  });
  afterAll(async () => {
    await handle.close();
  });

  it("returns no rows of user B to a session scoped to user A", async () => {
    const asA = (table: string) =>
      handle.db.transaction(async (tx) => {
        await tx.execute(sql.raw("SET LOCAL ROLE identity_app"));
        await tx.execute(sql`SELECT set_config('app.user_id', 'ua', true)`);
        const res = await tx.execute<{ user_id: string }>(
          sql.raw(`SELECT user_id FROM identity.${table}`),
        );
        return res.rows;
      });
    for (const table of ["user_settings", "setting_audit", "onboarding_steps", "secrets"]) {
      const rows = await asA(table);
      expect(rows.length, table).toBe(1);
      expect(
        rows.every((r) => r.user_id === "ua"),
        table,
      ).toBe(true);
    }
  });

  it("returns nothing without a user on the connection and refuses cross-user writes", async () => {
    await handle.db.transaction(async (tx) => {
      await tx.execute(sql.raw("SET LOCAL ROLE identity_app"));
      const res = await tx.execute(sql.raw("SELECT 1 FROM identity.secrets"));
      expect(res.rows).toEqual([]);
    });
    await expect(
      handle.db.transaction(async (tx) => {
        await tx.execute(sql.raw("SET LOCAL ROLE identity_app"));
        await tx.execute(sql.raw("SET LOCAL app.user_id = 'ua'"));
        await tx.execute(
          sql.raw(
            "INSERT INTO identity.secrets (user_id, kind, key_id, payload, updated_at) VALUES ('ub','x','k1','p', now())",
          ),
        );
      }),
    ).rejects.toThrow();
  });

  it("the store reads only the caller's rows and never mixes users", async () => {
    expect(Object.keys(await store.getSettingOverrides("ua"))).toEqual(["k"]);
    expect((await store.listSecrets("ua")).map((s) => s.userId)).toEqual(["ua"]);
    expect(await store.findSecret("ub", "llm_key")).toMatchObject({ userId: "ub" });
    expect(await store.listSettingAudit("ua")).toHaveLength(1);
    await store.deleteSecret("ua", "llm_key");
    expect(await store.listSecrets("ua")).toEqual([]);
    expect(await store.listSecrets("ub")).toHaveLength(1);
  });
});
