import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

const MIGRATIONS_DIR = fileURLToPath(new URL("../drizzle", import.meta.url));

/**
 * Applies `drizzle/*.sql` in name order, each once, inside a transaction.
 * Applied files are recorded in identity.schema_migrations. Returns the names applied now.
 */
export async function migrate(db: NodePgDatabase, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.execute(sql.raw('CREATE SCHEMA IF NOT EXISTS "identity"'));
  await db.execute(
    sql.raw('CREATE TABLE IF NOT EXISTS "identity"."schema_migrations" ("name" text PRIMARY KEY)'),
  );
  const done = new Set(
    (
      await db.execute<{ name: string }>(
        sql.raw('SELECT "name" FROM "identity"."schema_migrations"'),
      )
    ).rows.map((r) => r.name),
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const text = await readFile(join(dir, file), "utf8");
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(text));
      await tx.execute(sql`INSERT INTO "identity"."schema_migrations" ("name") VALUES (${file})`);
    });
    applied.push(file);
  }
  return applied;
}
