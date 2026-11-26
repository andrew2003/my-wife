import { describe, expect, it } from "vitest";
import { SETTINGS } from "@my-wife/contracts";
import { createMemoryStore } from "@my-wife/identity";
import {
  DEMO_USER_ID,
  buildDemoState,
  createDemoWorld,
  describeDemoState,
  resetDemoState,
} from "../src/demo-state";

const NOW = new Date("2026-11-27T01:00:00.000Z");

async function snapshot(store: ReturnType<typeof createMemoryStore>) {
  return {
    user: await store.findUserById(DEMO_USER_ID),
    settings: await store.getSettingOverrides(DEMO_USER_ID),
    audit: (await store.listSettingAudit(DEMO_USER_ID)).length,
  };
}

describe("demo state", () => {
  it("creates a demo user, cycle, schedule and routines from an empty database", async () => {
    const store = createMemoryStore();
    const world = createDemoWorld();
    await resetDemoState({ store, world, now: NOW });
    const user = await store.findUserById(DEMO_USER_ID);
    expect(user?.state).toBe("active");
    expect(world.state?.cycle.state).toBe("running");
    expect(world.state?.cycle.categories.length).toBeGreaterThan(0);
    const sum = world.state!.cycle.categories.reduce((s, c) => s + c.cycleLimitVnd, 0);
    expect(sum).toBe(world.state!.cycle.totalVnd);
    expect(world.state?.schedule.length).toBeGreaterThan(0);
    expect(world.state?.routines.map((r) => r.key)).toContain("wake");
  });

  it("is idempotent: a second run changes nothing", async () => {
    const store = createMemoryStore();
    const world = createDemoWorld();
    await resetDemoState({ store, world, now: NOW });
    const first = { snap: await snapshot(store), state: structuredClone(world.state) };
    await resetDemoState({ store, world, now: NOW });
    expect({ snap: await snapshot(store), state: world.state }).toEqual(first);
  });

  it("resets a dirty demo state to the same state", async () => {
    const store = createMemoryStore();
    const world = createDemoWorld();
    await resetDemoState({ store, world, now: NOW });
    const clean = { snap: await snapshot(store), state: structuredClone(world.state) };

    const user = (await store.findUserById(DEMO_USER_ID))!;
    await store.saveUser({ ...user, state: "suspended", locale: "en" });
    await store.saveSetting(DEMO_USER_ID, "notify.channel", "discord", {
      id: "x",
      userId: DEMO_USER_ID,
      actorId: DEMO_USER_ID,
      key: "notify.channel",
      before: "telegram",
      after: "discord",
      at: NOW.toISOString(),
    });
    await store.saveSession({
      id: "dirty-session",
      userId: DEMO_USER_ID,
      createdAt: NOW.toISOString(),
      expiresAt: "2030-01-01T00:00:00.000Z",
      revokedAt: null,
    });
    world.state!.cycle.state = "closed";
    world.state!.channels.length = 0;

    await resetDemoState({ store, world, now: NOW });
    const after = await snapshot(store);
    expect(after.user).toEqual(clean.snap.user);
    // An override that equals the default is the same state as no override.
    const effective = (s: Record<string, unknown>) => s["notify.channel"] ?? "telegram";
    expect(effective(after.settings)).toBe(effective(clean.snap.settings));
    expect(world.state).toEqual(clean.state);
    const dirty = (await store.listSessions(DEMO_USER_ID)).find((s) => s.id === "dirty-session");
    expect(dirty?.revokedAt).not.toBeNull();
  });

  it("links an emulated Telegram chat as primary and Discord as secondary", async () => {
    const state = buildDemoState(NOW);
    expect(state.channels).toEqual([
      expect.objectContaining({ kind: "telegram", role: "primary", emulated: true }),
      expect.objectContaining({ kind: "discord", role: "secondary" }),
    ]);
    const store = createMemoryStore();
    await resetDemoState({ store, world: createDemoWorld(), now: NOW });
    const settings = await store.getSettingOverrides(DEMO_USER_ID);
    expect(settings["notify.channel"] ?? SETTINGS["notify.channel"].default).toBe("telegram");
    const out = describeDemoState(state);
    expect(out).toContain("primary channel: telegram");
    expect(out).toContain("secondary channel: discord");
  });

  it("takes time as a parameter", () => {
    const a = buildDemoState(new Date("2026-11-27T01:00:00.000Z"));
    const b = buildDemoState(new Date("2026-12-27T01:00:00.000Z"));
    expect(a.cycle.startsAt).not.toBe(b.cycle.startsAt);
    expect(buildDemoState(NOW)).toEqual(buildDemoState(NOW));
  });
});
