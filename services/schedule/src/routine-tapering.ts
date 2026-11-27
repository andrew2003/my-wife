import type { EventEnvelope } from "@my-wife/contracts";
import { SETTINGS } from "@my-wife/contracts";
import { zoneParts, zoneSetting } from "./review";
import {
  buildStarterRoutines,
  effectiveLevel,
  type RoutineDeps,
  type RoutineLevel,
} from "./routines";

const DAY_MS = 24 * 60 * 60_000;
/** Lowest level the bot may propose per routine; the wake check-in is kept (spec 22 section 5). */
const FLOOR: Record<string, RoutineLevel> = { wake: "track" };
/** One step down from each level; `off` has nowhere to go. */
const STEP_DOWN: Partial<Record<RoutineLevel, RoutineLevel>> = {
  commit: "track",
  track: "remind",
  remind: "off",
};
const ORDER: readonly RoutineLevel[] = ["off", "remind", "track", "commit"];

/** Port: one flag per routine and local day, and the streaks already proposed. */
export interface HabitStore {
  recordDay(userId: string, routineId: string, date: string, regular: boolean): void;
  isRegular(userId: string, routineId: string, date: string): boolean;
  hasProposed(key: string): boolean;
  markProposed(key: string): void;
}

export function createMemoryHabitStore(): HabitStore {
  const days = new Map<string, boolean>();
  const proposed = new Set<string>();
  return {
    recordDay: (u, r, d, regular) => void days.set(`${u}|${r}|${d}`, regular),
    isRegular: (u, r, d) => days.get(`${u}|${r}|${d}`) === true,
    hasProposed: (k) => proposed.has(k),
    markProposed: (k) => void proposed.add(k),
  };
}

/** How long a proposal stays open when no option is injected: one week (ADR pending for a setting). */
export const DEFAULT_TAPER_ASK_EXPIRY_MS = 7 * DAY_MS;

export interface TaperDeps extends RoutineDeps {
  /** Proposal lifetime in milliseconds from the review time. */
  askExpiryMs?: number;
  habits: HabitStore;
}

/** `routine.habit_stable_days`; an invalid value falls back to the registry default. */
export function habitStableDays(raw: Record<string, unknown>): number {
  const v = raw["routine.habit_stable_days"];
  return typeof v === "number" && Number.isInteger(v) && v > 0
    ? v
    : (SETTINGS["routine.habit_stable_days"].default as number);
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The lower level to propose: one step down, never below the floor of the routine. */
export function lowerLevel(routineId: string, level: RoutineLevel): RoutineLevel | undefined {
  const next = STEP_DOWN[level];
  if (!next) return undefined;
  const floor = FLOOR[routineId] ?? "off";
  return ORDER.indexOf(next) < ORDER.indexOf(floor) ? undefined : next;
}

/**
 * Weekly review step: for every routine whose regular days run unbroken up to yesterday for at
 * least `routine.habit_stable_days`, asks the user whether to lower the level
 * (`ask.routine_checkin`, kind `routine_taper`). It only proposes: no level is changed and no
 * fault can arise. One proposal per routine, level and streak. `now` is a parameter.
 */
export async function runTaperingReviewForUser(
  deps: TaperDeps,
  userId: string,
  now: Date,
): Promise<string[]> {
  const raw = await deps.readSettings(userId);
  const stable = habitStableDays(raw);
  const zone = zoneSetting(raw["calendar.time_zone"]);
  const p = zoneParts(now.getTime(), zone);
  const today = Date.UTC(p.y, p.mo - 1, p.d);
  const proposed: string[] = [];
  for (const r of buildStarterRoutines(raw)) {
    // A lowering that is still pending already is a change; do not stack another.
    if (deps.store.getChange(userId, r.id)) continue;
    const from = effectiveLevel(deps.store, userId, r, now);
    const to = lowerLevel(r.id, from);
    if (!to) continue;
    let streak = 0;
    while (deps.habits.isRegular(userId, r.id, isoDay(today - (streak + 1) * DAY_MS))) streak++;
    if (streak < stable) continue;
    const key = `${userId}|${r.id}|${from}|${isoDay(today - streak * DAY_MS)}`;
    if (deps.habits.hasProposed(key)) continue;
    const id = `ask-routine-taper-${key.replaceAll("|", "-")}`;
    await deps.plan.publish({
      id,
      type: "ask.routine_checkin",
      occurredAt: deps.plan.now().toISOString(),
      userId,
      schemaVersion: 1,
      payload: {
        questionId: id,
        kind: "routine_taper",
        subjectRef: `routine:${r.id}`,
        options: ["accept", "keep"].map((value) => ({
          value,
          labelKey: `routine.taper.option.${value}`,
        })),
        expiresAt: new Date(
          now.getTime() + (deps.askExpiryMs ?? DEFAULT_TAPER_ASK_EXPIRY_MS),
        ).toISOString(),
        params: {
          routineId: r.id,
          from,
          to,
          streakDays: streak,
          messageKey: "routine.taper.question",
        },
      },
    } as EventEnvelope);
    deps.habits.markProposed(key);
    proposed.push(r.id);
  }
  return proposed;
}

export async function runTaperingReview(
  deps: TaperDeps,
  now: Date,
): Promise<{ checked: number; proposed: number; failed: string[] }> {
  const users = [...new Set(deps.plan.store.allWeeks().map((w) => w.userId))];
  const failed: string[] = [];
  let proposed = 0;
  for (const userId of users) {
    try {
      proposed += (await runTaperingReviewForUser(deps, userId, now)).length;
    } catch {
      failed.push(userId);
    }
  }
  return { checked: users.length, proposed, failed };
}
