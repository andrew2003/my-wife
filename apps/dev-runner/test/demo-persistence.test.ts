import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryStore } from "@my-wife/identity";
import {
  createDemoWorld,
  createFileDemoStateStore,
  ensureDemoState,
  resetDemoState,
} from "../src/demo-state";
import { runDemoReset } from "../src/demo-reset";
import { prepareDemoLogin } from "../src/demo-login";

const SECRET = "s".repeat(40);
const T1 = new Date("2026-11-27T01:00:00.000Z");
const T2 = new Date("2026-12-05T09:00:00.000Z");
const dirs: string[] = [];
function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "demo-state-"));
  dirs.push(dir);
  return join(dir, "nested", "state.json");
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("demo state persistence", () => {
  it("keeps the cycle, ten blocks and two routines after a restart", async () => {
    const file = tmpFile();
    const first = await resetDemoState({
      store: createMemoryStore(),
      world: createDemoWorld(createFileDemoStateStore(file)),
      now: T1,
    });
    expect(first.schedule).toHaveLength(10);
    expect(first.routines).toHaveLength(2);

    // Restart: new world, new empty identity store, later clock.
    const world = createDemoWorld(createFileDemoStateStore(file));
    const store = createMemoryStore();
    const restored = await ensureDemoState({ store, world, now: T2 });
    expect(restored).toEqual(first);
    expect(world.state).toEqual(first);
    expect((await store.findUserById(first.user.id))?.state).toBe("active");
  });

  it("builds a fresh state when nothing is persisted", async () => {
    const world = createDemoWorld(createFileDemoStateStore(tmpFile()));
    const state = await ensureDemoState({ store: createMemoryStore(), world, now: T1 });
    expect(state.cycle.firstDay).toBe("2026-11-27");
  });

  it("rebuilds from scratch when the persisted file is unreadable", async () => {
    const file = tmpFile();
    const store = createFileDemoStateStore(file);
    await store.save({ not: "a state" } as never);
    const state = await ensureDemoState({
      store: createMemoryStore(),
      world: createDemoWorld(store),
      now: T1,
    });
    expect(state.schedule).toHaveLength(10);
  });

  it("demo:reset writes the file and replaces an older state", async () => {
    const file = tmpFile();
    await runDemoReset({ DEMO_STATE_FILE: file, DEMO_NOW: T1.toISOString() });
    expect(existsSync(file)).toBe(true);
    await runDemoReset({ DEMO_STATE_FILE: file, DEMO_NOW: T2.toISOString() });
    const saved = await createFileDemoStateStore(file).load();
    expect(saved?.cycle.firstDay).toBe("2026-12-05");
  });

  it("demo login keeps the persisted state on restart", async () => {
    const file = tmpFile();
    await runDemoReset({ DEMO_STATE_FILE: file, DEMO_NOW: T1.toISOString() });
    const login = await prepareDemoLogin({
      env: { DEMO_LOGIN: "1", DEMO_STATE_FILE: file },
      store: createMemoryStore(),
      secret: SECRET,
      now: T2,
      port: 0,
    });
    try {
      const saved = await createFileDemoStateStore(file).load();
      expect(saved?.cycle.firstDay).toBe("2026-11-27");
    } finally {
      await login?.stop();
    }
  });
});
