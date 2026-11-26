import { drizzle } from "drizzle-orm/node-postgres";
import { pgSchema } from "drizzle-orm/pg-core";
import pg from "pg";

/** Each service reads and writes only its own schema (ADR 0004). */
export function serviceSchema(name: string) {
  return pgSchema(name);
}

/** Lazy pool: nothing connects until the first query. */
export function createDb(databaseUrl: string) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  return { db: drizzle(pool), close: () => pool.end() };
}
