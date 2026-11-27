import type { EventEnvelope } from "@my-wife/contracts";
import { RoutineLevelSchema, SETTINGS, WeekdaySchema } from "@my-wife/contracts";
import type { PlanDeps } from "./plan";
import { zoneParts, zoneSetting, zonedInstant } from "./review";
import type { SessionStore, WorkSession } from "./sessions";

const DAY_MS = 24 * 60 * 60_000;
const WEEKDAYS = WeekdaySchema.options as readonly string[];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export type RoutineLevel = ReturnType<typeof RoutineLevelSchema.parse>;
export type RoutineKind = "sleep" | "wake" | "meal" | "exercise" | "custom";

/** Increasing commitment; lowering from `commit` is loosening (spec 22 section 1). */
const LEVEL_ORDER: readonly RoutineLevel[] = ["off", "remind", "track", "commit"];

interface MealDefault {
  id: string;
  settingKey: string;
  from: string;
  to: string;
  durationMinutes: number;
}

/**
 * Meal windows. Lunch is a registry setting; breakfast and dinner defaults come from the
 * decision log (M4 audit) and may be overridden by the settings `routine.meal.<id>_window`.
 */
const MEALS: readonly MealDefault[] = [
  {
    id: "breakfast",
    settingKey: "routine.meal.breakfast_window",
    from: "06:30",
    to: "08:00",
    durationMinutes: 20,
  },
  {
    id: "lunch",
    settingKey: "routine.meal.lunch_window",
    ...(SETTINGS["routine.meal.lunch_window"].default as {
      from: string;
      to: string;
      durationMinutes: number;
    }),
  },
  {
    id: "dinner",
    settingKey: "routine.meal.dinner_window",
    from: "18:30",
    to: "20:00",
    durationMinutes: 30,
  },
];

export interface StarterRoutine {
  id: string;
  kind: RoutineKind;
  /** Level from settings, before any pending change. */
  level: RoutineLevel;
  /** Meals only: the window and the length of the block. */
  window?: { from: string; to: string; durationMinutes: number };
}

/**
 * Level of one routine: the override `routine.<id>.level`, else the group key (for example
 * `routine.meals.level`). Invalid values fall back to the registry default of the group.
 */
export function resolveRoutineLevel(
  raw: Record<string, unknown>,
  routineId: string,
  groupKey: string,
): RoutineLevel {
  const own = RoutineLevelSchema.safeParse(raw[`routine.${routineId}.level`]);
  if (own.success) return own.data;
  const group = RoutineLevelSchema.safeParse(raw[groupKey]);
  if (group.success) return group.data;
  const def = (SETTINGS as Record<string, { default: unknown }>)[groupKey]?.default;
  const parsed = RoutineLevelSchema.safeParse(def);
  return parsed.success ? parsed.data : "off";
}

function mealWindow(raw: Record<string, unknown>, m: MealDefault) {
  const v = raw[m.settingKey] as
    { from?: unknown; to?: unknown; durationMinutes?: unknown } | undefined;
  if (
    v &&
    typeof v.from === "string" &&
    TIME.test(v.from) &&
    typeof v.to === "string" &&
    TIME.test(v.to) &&
    v.from < v.to &&
    typeof v.durationMinutes === "number" &&
    Number.isInteger(v.durationMinutes) &&
    v.durationMinutes > 0
  ) {
    return { from: v.from, to: v.to, durationMinutes: v.durationMinutes };
  }
  return { from: m.from, to: m.to, durationMinutes: m.durationMinutes };
}

/** The starter template: sleep and meals at `track`, wake-up at `remind` (all settings). */
export function buildStarterRoutines(raw: Record<string, unknown>): StarterRoutine[] {
  return [
    { id: "sleep", kind: "sleep", level: resolveRoutineLevel(raw, "sleep", "routine.sleep.level") },
    { id: "wake", kind: "wake", level: resolveRoutineLevel(raw, "wake", "routine.wake.level") },
    ...MEALS.map((m): StarterRoutine => ({
      id: m.id,
      kind: "meal",
      level: resolveRoutineLevel(raw, m.id, "routine.meals.level"),
      window: mealWindow(raw, m),
    })),
  ];
}

export interface LevelChange {
  userId: string;
  routineId: string;
  /** Level that stays in force until `effectiveFrom`. */
  from: RoutineLevel;
  to: RoutineLevel;
  effectiveFrom: string;
}

/** Port: the Drizzle store replaces the in-memory one without touching the logic. */
export interface RoutineStore {
  getChange(userId: string, routineId: string): LevelChange | undefined;
  putChange(change: LevelChange): void;
  deleteChange(userId: string, routineId: string): void;
  hasReminded(id: string): boolean;
  markReminded(id: string): void;
}

export function createMemoryRoutineStore(): RoutineStore {
  const changes = new Map<string, LevelChange>();
  const reminded = new Set<string>();
  const key = (u: string, r: string) => `${u}|${r}`;
  return {
    getChange: (u, r) => changes.get(key(u, r)),
    putChange: (c) => void changes.set(key(c.userId, c.routineId), c),
    deleteChange: (u, r) => void changes.delete(key(u, r)),
    hasReminded: (id) => reminded.has(id),
    markReminded: (id) => void reminded.add(id),
  };
}

export interface RoutineDeps {
  plan: PlanDeps;
  store: RoutineStore;
  readSettings: (userId: string) => Promise<Record<string, unknown>>;
  /** Work sessions, to see whether the user worked through a meal window. */
  sessions?: SessionStore;
  /** Today's dish for a meal from the budget menu; undefined when there is none. */
  menuSource?: MenuSource;
}

/** Port: budget's weekly menu. `date` is the user's local day (YYYY-MM-DD). */
export type MenuSource = (
  userId: string,
  date: string,
  mealId: string,
) => Promise<string | undefined>;

/** Level in force at `now`: a lowering from `commit` keeps the old level until it takes effect. */
export function effectiveLevel(
  store: RoutineStore,
  userId: string,
  routine: StarterRoutine,
  now: Date,
): RoutineLevel {
  const change = store.getChange(userId, routine.id);
  if (change && now.getTime() < Date.parse(change.effectiveFrom)) return change.from;
  return routine.level;
}

/** Local midnight of the next `calendar.week_start_day` strictly after `now`. */
export function nextWeekStart(now: Date, raw: Record<string, unknown>): Date {
  const zone = zoneSetting(raw["calendar.time_zone"]);
  const parsed = WeekdaySchema.safeParse(raw["calendar.week_start_day"]);
  const startDay = parsed.success
    ? parsed.data
    : (SETTINGS["calendar.week_start_day"].default as string);
  const p = zoneParts(now.getTime(), zone);
  const delta = (WEEKDAYS.indexOf(startDay) - WEEKDAYS.indexOf(p.weekday) + 7) % 7 || 7;
  const day = new Date(Date.UTC(p.y, p.mo - 1, p.d) + delta * DAY_MS);
  return new Date(
    zonedInstant(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), 0, 0, zone),
  );
}

const kindOf = (routineId: string): RoutineKind =>
  routineId === "sleep" || routineId === "wake" || routineId === "exercise"
    ? routineId
    : MEALS.some((m) => m.id === routineId)
      ? "meal"
      : "custom";

/**
 * Records a saved level change and announces `routine.level_changed`. A raise, or any change
 * not starting at `commit`, applies at once; lowering from `commit` applies from the next
 * week (spec 22 section 1). A pending lowering keeps its original date when changed again.
 */
export async function changeRoutineLevel(
  deps: RoutineDeps,
  userId: string,
  input: { routineId: string; from: RoutineLevel; to: RoutineLevel },
  now: Date,
): Promise<LevelChange> {
  const raw = await deps.readSettings(userId);
  const pending = deps.store.getChange(userId, input.routineId);
  const inForce =
    pending && now.getTime() < Date.parse(pending.effectiveFrom) ? pending : undefined;
  const from = inForce ? inForce.from : input.from;
  const loosening =
    from === "commit" && LEVEL_ORDER.indexOf(input.to) < LEVEL_ORDER.indexOf("commit");
  const effectiveFrom = loosening
    ? (inForce?.effectiveFrom ?? nextWeekStart(now, raw).toISOString())
    : now.toISOString();
  const change: LevelChange = {
    userId,
    routineId: input.routineId,
    from,
    to: input.to,
    effectiveFrom,
  };
  await deps.plan.publish({
    id: `routine-level-changed-${userId}-${input.routineId}-${now.getTime()}`,
    type: "routine.level_changed",
    occurredAt: deps.plan.now().toISOString(),
    userId,
    schemaVersion: 1,
    payload: { routine: kindOf(input.routineId), from, to: input.to, effectiveFrom },
  } as EventEnvelope);
  if (loosening) deps.store.putChange(change);
  else deps.store.deleteChange(userId, input.routineId);
  return change;
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Sends the meal reminder once the window opens, for every routine not `off`. A `remind`
 * routine only sends the message: no check-in is asked and no fault can arise. Idempotent;
 * `now` is a parameter; state is saved only after a successful publish.
 */
export async function runRoutineRemindersForUser(
  deps: RoutineDeps,
  userId: string,
  now: Date,
): Promise<void> {
  const raw = await deps.readSettings(userId);
  const zone = zoneSetting(raw["calendar.time_zone"]);
  const nowMs = now.getTime();
  const p = zoneParts(nowMs, zone);
  const date = `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
  for (const r of buildStarterRoutines(raw)) {
    if (!r.window) continue;
    if (effectiveLevel(deps.store, userId, r, now) === "off") continue;
    const [fh, fm] = r.window.from.split(":").map(Number) as [number, number];
    const [th, tm] = r.window.to.split(":").map(Number) as [number, number];
    const startMs = zonedInstant(p.y, p.mo, p.d, fh, fm, zone);
    const endMs = zonedInstant(p.y, p.mo, p.d, th, tm, zone);
    if (nowMs < startMs || nowMs >= endMs) continue;
    const id = `routine-reminder-${userId}-${r.id}-${date}`;
    if (deps.store.hasReminded(id)) continue;
    await deps.plan.publish({
      id,
      type: "routine.reminder_due",
      occurredAt: deps.plan.now().toISOString(),
      userId,
      schemaVersion: 1,
      payload: {
        routine: r.kind,
        dueAt: new Date(startMs).toISOString(),
        messageKey: `routine.meal_reminder.${r.id}`,
        params: { from: r.window.from, to: r.window.to, minutes: r.window.durationMinutes },
      },
    } as EventEnvelope);
    deps.store.markReminded(id);
  }
}

const sessionEndMs = (s: WorkSession) =>
  s.endedAt !== null ? Date.parse(s.endedAt) : Date.parse(s.startedAt) + s.durationMinutes * 60_000;

/**
 * Once a meal window has passed and a work session overlapped it, prompts a meal break (once
 * per meal and day). When the budget has a menu for the day the prompt names the dish; a
 * missing menu or a failed lookup gives the plain prompt. Never a fault. `now` is a parameter.
 */
export async function runMealBreakPromptsForUser(
  deps: RoutineDeps,
  userId: string,
  now: Date,
): Promise<void> {
  if (!deps.sessions) return;
  const raw = await deps.readSettings(userId);
  const zone = zoneSetting(raw["calendar.time_zone"]);
  const nowMs = now.getTime();
  const p = zoneParts(nowMs, zone);
  const date = `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
  const mine = deps.sessions.all().filter((s) => s.userId === userId);
  for (const r of buildStarterRoutines(raw)) {
    if (!r.window) continue;
    if (effectiveLevel(deps.store, userId, r, now) === "off") continue;
    const [fh, fm] = r.window.from.split(":").map(Number) as [number, number];
    const [th, tm] = r.window.to.split(":").map(Number) as [number, number];
    const startMs = zonedInstant(p.y, p.mo, p.d, fh, fm, zone);
    const endMs = zonedInstant(p.y, p.mo, p.d, th, tm, zone);
    if (nowMs < endMs) continue;
    const id = `routine-meal-break-${userId}-${r.id}-${date}`;
    if (deps.store.hasReminded(id)) continue;
    const worked = mine.some((s) => Date.parse(s.startedAt) < endMs && sessionEndMs(s) > startMs);
    if (!worked) continue;
    let dish: string | undefined;
    try {
      dish = await deps.menuSource?.(userId, date, r.id);
    } catch {
      dish = undefined;
    }
    dish = dish?.trim() || undefined;
    await deps.plan.publish({
      id,
      type: "routine.reminder_due",
      occurredAt: deps.plan.now().toISOString(),
      userId,
      schemaVersion: 1,
      payload: {
        routine: r.kind,
        dueAt: new Date(endMs).toISOString(),
        messageKey: `routine.meal_break.${r.id}${dish ? "_menu" : ""}`,
        params: { minutes: r.window.durationMinutes, ...(dish ? { dish } : {}) },
      },
    } as EventEnvelope);
    deps.store.markReminded(id);
  }
}

export async function runRoutineReminderJob(
  deps: RoutineDeps,
  now: Date,
): Promise<{ checked: number; failed: string[] }> {
  const users = [...new Set(deps.plan.store.allWeeks().map((w) => w.userId))];
  const failed: string[] = [];
  for (const userId of users) {
    try {
      await runRoutineRemindersForUser(deps, userId, now);
      await runMealBreakPromptsForUser(deps, userId, now);
    } catch {
      failed.push(userId);
    }
  }
  return { checked: users.length, failed };
}
