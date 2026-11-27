import { createDrizzleStore, createMemoryStore, type IdentityStore } from "@my-wife/identity";
import { createDb } from "@my-wife/service-kit";
import {
  createDemoWorld,
  demoStateStoreFromEnv,
  describeDemoState,
  resetDemoState,
} from "./demo-state";

/**
 * `pnpm demo:reset`: rebuilds the demo state and prints it, including both linked channels.
 * With DATABASE_URL set it writes the identity schema (migrated by the identity service);
 * otherwise it uses an in-memory store. The demo state is also written to DEMO_STATE_FILE
 * (default `.demo/demo-state.json`) so a restarted runner keeps it. DEMO_NOW pins the simulated time (ISO 8601).
 */
export async function runDemoReset(env: Record<string, string | undefined>): Promise<string> {
  const now = env.DEMO_NOW ? new Date(env.DEMO_NOW) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error("DEMO_NOW must be an ISO 8601 date-time");
  let store: IdentityStore = createMemoryStore();
  let close: (() => Promise<void>) | undefined;
  if (env.DATABASE_URL) {
    const db = createDb(env.DATABASE_URL);
    store = createDrizzleStore(db.db);
    close = async () => void (await db.close());
  }
  try {
    const state = await resetDemoState({
      store,
      world: createDemoWorld(demoStateStoreFromEnv(env)),
      now,
    });
    return describeDemoState(state);
  } finally {
    await close?.();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(await runDemoReset(process.env));
}
