import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { SETTINGS, type ChannelKind, type CycleState, type SettingKey } from "@my-wife/contracts";
import { buildSampleBudget, DEFAULT_SAMPLE_TOTAL_VND } from "@my-wife/budget";
import type { IdentityStore } from "@my-wife/identity";
import { buildSampleDay, type SampleBlock } from "@my-wife/schedule";

/** Fixed ids make the reset repeatable: the same demo user is rewritten, never duplicated. */
export const DEMO_USER_ID = "0190a0a0-0000-7000-8000-0000000000d1";
export const DEMO_CYCLE_ID = "0190a0a0-0000-7000-8000-0000000000d2";
export const DEMO_USER_EMAIL = "demo@example.test";
const DEMO_ACTOR = "demo-reset";

export interface DemoChannel {
  kind: ChannelKind;
  role: "primary" | "secondary";
  /** Emulated chats talk to an in-process fake, not to the real network. */
  emulated: boolean;
  externalId: string;
}

export interface DemoRoutine {
  key: "wake" | "bedtime";
  level: string;
  time: string;
}

export interface DemoCycle {
  id: string;
  state: CycleState;
  firstDay: string;
  startsAt: string;
  endsAt: string;
  weeks: number;
  totalVnd: number;
  categories: { key: string; shortCode: string; cycleLimitVnd: number }[];
}

export interface DemoState {
  user: { id: string; email: string; locale: "vi" | "en" };
  /** User settings the demo sets; every other override is reset to the registry default. */
  settings: Partial<Record<SettingKey, unknown>>;
  cycle: DemoCycle;
  schedule: SampleBlock[];
  routines: DemoRoutine[];
  channels: DemoChannel[];
}

/** Holds the parts of the demo state that have no persistent store yet (in-process services). */
export interface DemoWorld {
  state: DemoState | undefined;
  /** Where the state survives a restart; absent means in-process only. */
  persistence?: DemoStateStore;
}

/** Keeps the demo state outside the process so a restart finds the same cycle and routines. */
export interface DemoStateStore {
  /** Undefined when nothing usable is stored (missing, unreadable or malformed). */
  load(): Promise<DemoState | undefined>;
  save(state: DemoState): Promise<void>;
}

export function createDemoWorld(persistence?: DemoStateStore): DemoWorld {
  return { state: undefined, persistence };
}

/** Default location, relative to the working directory; `.demo/` is ignored by git. */
export const DEFAULT_DEMO_STATE_FILE = ".demo/demo-state.json";

function looksLikeDemoState(value: unknown): value is DemoState {
  const v = value as Partial<DemoState> | null;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.user?.id === "string" &&
    typeof v.cycle?.id === "string" &&
    Array.isArray(v.cycle.categories) &&
    Array.isArray(v.schedule) &&
    v.schedule.length > 0 &&
    Array.isArray(v.routines) &&
    Array.isArray(v.channels)
  );
}

/** JSON file store; writes go through a temporary file so a crash never leaves half a state. */
export function createFileDemoStateStore(path: string): DemoStateStore {
  return {
    async load() {
      try {
        const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
        return looksLikeDemoState(parsed) && parsed.user.id === DEMO_USER_ID ? parsed : undefined;
      } catch {
        return undefined;
      }
    },
    async save(state) {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
      await rename(tmp, path);
    },
  };
}

/** The file store named by DEMO_STATE_FILE (default `.demo/demo-state.json`). */
export function demoStateStoreFromEnv(env: Record<string, string | undefined>): DemoStateStore {
  return createFileDemoStateStore(env.DEMO_STATE_FILE || DEFAULT_DEMO_STATE_FILE);
}

const DAY_MS = 86_400_000;

/** Pure: the demo state for the given time. The same `now` always gives the same state. */
export function buildDemoState(now: Date): DemoState {
  const settings: Partial<Record<SettingKey, unknown>> = {
    "notify.channel": "telegram",
  };
  const weeks = SETTINGS["budget.cycle_weeks"].default as number;
  const rounding = SETTINGS["budget.weekly_limit_rounding_vnd"].default as number;
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const budget = buildSampleBudget({ totalVnd: DEFAULT_SAMPLE_TOTAL_VND, roundingVnd: rounding });
  const wake = (settings["routine.wake.time"] ?? SETTINGS["routine.wake.time"].default) as string;
  const sleep = (settings["routine.sleep.start"] ??
    SETTINGS["routine.sleep.start"].default) as string;
  return {
    user: { id: DEMO_USER_ID, email: DEMO_USER_EMAIL, locale: "vi" },
    settings,
    cycle: {
      id: DEMO_CYCLE_ID,
      state: "running" as CycleState,
      firstDay: first.toISOString().slice(0, 10),
      startsAt: first.toISOString(),
      endsAt: new Date(first.getTime() + weeks * 7 * DAY_MS).toISOString(),
      weeks,
      totalVnd: budget.totalVnd,
      categories: budget.categories.map((c) => ({
        key: c.key,
        shortCode: c.shortCode,
        cycleLimitVnd: c.cycleLimitVnd,
      })),
    },
    schedule: buildSampleDay(settings),
    routines: [
      {
        key: "wake",
        level: SETTINGS["routine.wake.level"].default as string,
        time: wake,
      },
      { key: "bedtime", level: "remind", time: sleep },
    ],
    channels: [
      { kind: "telegram", role: "primary", emulated: true, externalId: "demo-telegram-chat" },
      { kind: "discord", role: "secondary", emulated: false, externalId: "demo-discord-channel" },
    ],
  };
}

/** Human-readable result of a reset; names both linked channels. */
export function describeDemoState(state: DemoState): string {
  const primary = state.channels.find((c) => c.role === "primary");
  const secondary = state.channels.find((c) => c.role === "secondary");
  const label = (c: DemoChannel | undefined) =>
    c ? `${c.kind}${c.emulated ? " (emulated)" : ""}` : "none";
  return [
    `demo user: ${state.user.email} (${state.user.id})`,
    `cycle: ${state.cycle.id} running ${state.cycle.firstDay}, ${state.cycle.weeks} weeks, ${state.cycle.totalVnd} VND`,
    `schedule blocks: ${state.schedule.length}`,
    `routines: ${state.routines.map((r) => r.key).join(", ")}`,
    `primary channel: ${label(primary)}`,
    `secondary channel: ${label(secondary)}`,
  ].join("\n");
}

export interface ResetOptions {
  store: IdentityStore;
  world: DemoWorld;
  now: Date;
}

/**
 * Rewrites the demo user and everything owned by it to the state of `buildDemoState(now)`.
 * Idempotent: a clean state is left as it is, with no extra audit entries. Sessions are
 * revoked, settings the demo does not set go back to the registry default.
 */
export async function resetDemoState(opts: ResetOptions): Promise<DemoState> {
  return applyDemoState(opts, buildDemoState(opts.now));
}

/**
 * Startup path: reuses the persisted demo state when there is one (the cycle, blocks and
 * routines survive a restart) and builds a fresh one otherwise. The identity side is
 * rewritten either way, since the runner's identity store may be empty after a restart.
 */
export async function ensureDemoState(opts: ResetOptions): Promise<DemoState> {
  const saved = await opts.world.persistence?.load();
  return applyDemoState(opts, saved ?? buildDemoState(opts.now));
}

async function applyDemoState(opts: ResetOptions, state: DemoState): Promise<DemoState> {
  const { store, world, now } = opts;
  const at = now.toISOString();
  const existing = await store.findUserById(state.user.id);
  await store.saveUser({
    id: state.user.id,
    email: state.user.email,
    state: "active",
    // The demo user is the showcase account and sees every screen, the admin ones included.
    role: "admin",
    locale: state.user.locale,
    lastSeenAt: null,
    activatedEventAt: existing?.activatedEventAt ?? at,
  });

  const current = await store.getSettingOverrides(state.user.id);
  const wanted: Record<string, unknown> = { ...state.settings };
  for (const key of Object.keys(current)) {
    if (!(key in wanted) && key in SETTINGS) wanted[key] = SETTINGS[key as SettingKey].default;
  }
  const changes = Object.entries(wanted)
    .filter(([key, value]) => JSON.stringify(current[key] ?? null) !== JSON.stringify(value))
    // A key never overridden that already equals its default needs no row.
    .filter(
      ([key, value]) =>
        key in current ||
        JSON.stringify(SETTINGS[key as SettingKey].default) !== JSON.stringify(value),
    )
    .map(([key, value]) => ({
      key,
      value,
      audit: {
        // A random suffix keeps the id unique when DEMO_NOW pins `at` across resets.
        id: `demo-${key}-${at}-${randomUUID()}`,
        userId: state.user.id,
        actorId: DEMO_ACTOR,
        key,
        before: current[key] ?? SETTINGS[key as SettingKey].default,
        after: value,
        at,
      },
    }));
  if (changes.length > 0) await store.saveSettings(state.user.id, changes);

  for (const session of await store.listSessions(state.user.id)) {
    if (!session.revokedAt) await store.revokeSession(session.id, at);
  }

  world.state = state;
  await world.persistence?.save(state);
  return state;
}
