import { SETTINGS, TimeOfDaySchema, WeekdaySchema } from "@my-wife/contracts";
import type { PlanStore, PlanWeek } from "./plan";
import { buildStarterRoutines, type RoutineKind, type RoutineLevel } from "./routines";
import { addDays } from "./week-plan";

const WEEKDAYS = WeekdaySchema.options as readonly string[];
const DAY_MINUTES = 24 * 60;
const WEEK_DAYS = 7;
const DEFAULT_WEEKEND_DAYS = ["saturday", "sunday"];
const MEAL_IDS = ["breakfast", "lunch", "dinner"] as const;

export type DayProfile = "weekday" | "weekend";

export interface MinuteRange {
  start: string;
  end: string;
}

export interface RoutineBlockPlacement {
  /** Routine id: `sleep`, `breakfast`, `lunch`, `dinner`. */
  id: string;
  routine: RoutineKind;
  level: RoutineLevel;
  blockKind: "fixed" | "flexible";
  day: string;
  profile: DayProfile;
  /** Absent only for a flexible block that found no gap. */
  start?: string;
  end?: string;
  durationMinutes: number;
  placed: boolean;
}

const toMinutes = (t: string): number => {
  const [h, m] = t.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};
const fromMinutes = (n: number): string =>
  `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;

/** Weekend days are a setting (`routine.weekend_days`); the default is Saturday and Sunday. */
export function dayProfileOf(raw: Record<string, unknown>, isoDay: string): DayProfile {
  const configured = raw["routine.weekend_days"];
  const days =
    Array.isArray(configured) && configured.every((d) => WEEKDAYS.includes(d as string))
      ? (configured as string[])
      : DEFAULT_WEEKEND_DAYS;
  // Date.getUTCDay: 0 is Sunday; WEEKDAYS starts on Monday.
  const name = WEEKDAYS[(new Date(`${isoDay}T00:00:00Z`).getUTCDay() + 6) % 7] as string;
  return days.includes(name) ? "weekend" : "weekday";
}

/**
 * Settings seen by a day: a weekend day replaces the wake time, the sleep start and the meal
 * windows by `routine.weekend.*` values when present; otherwise the weekday values apply.
 */
function profileSettings(raw: Record<string, unknown>, profile: DayProfile) {
  if (profile === "weekday") return raw;
  const out = { ...raw };
  const pairs: [string, string][] = [
    ["routine.weekend.wake_time", "routine.wake.time"],
    ["routine.weekend.sleep_start", "routine.sleep.start"],
    ...MEAL_IDS.map((id): [string, string] => [
      `routine.weekend.meal.${id}_window`,
      `routine.meal.${id}_window`,
    ]),
  ];
  for (const [from, to] of pairs) if (raw[from] !== undefined) out[to] = raw[from];
  return out;
}

function time(raw: Record<string, unknown>, key: "routine.wake.time" | "routine.sleep.start") {
  const parsed = TimeOfDaySchema.safeParse(raw[key]);
  return parsed.success ? parsed.data : (SETTINGS[key].default as string);
}

/**
 * Pure: the earliest gap inside `window` that fits `durationMinutes` between the busy ranges.
 * Returns null when no gap is long enough.
 */
export function placeFlexibleBlock(input: {
  window: { from: string; to: string };
  durationMinutes: number;
  busy: MinuteRange[];
}): MinuteRange | null {
  const to = toMinutes(input.window.to);
  const ranges = input.busy
    .map((b) => [toMinutes(b.start), toMinutes(b.end)] as const)
    .sort((a, b) => a[0] - b[0]);
  let cursor = toMinutes(input.window.from);
  for (const [s, e] of ranges) {
    if (e <= cursor) continue;
    if (s >= cursor + input.durationMinutes) break;
    cursor = e;
  }
  if (cursor + input.durationMinutes > to) return null;
  return { start: fromMinutes(cursor), end: fromMinutes(cursor + input.durationMinutes) };
}

export interface DayRoutinePlan {
  profile: DayProfile;
  blocks: RoutineBlockPlacement[];
  /** Minutes of routine blocks that fall in the awake span, beyond what the span can hold. */
  excessMinutes: number;
  unplaced: number;
}

/**
 * Pure: routine blocks of one day, placed before tasks (spec 22 section 2). The fixed sleep
 * block is held; each flexible meal block goes into the earliest gap of its window (clamped to
 * the awake span) left by the timed tasks and the blocks placed before it. Routines at `off`
 * do not appear.
 */
export function planRoutineBlocks(
  raw: Record<string, unknown>,
  day: string,
  taskRanges: MinuteRange[],
): DayRoutinePlan {
  const profile = dayProfileOf(raw, day);
  const s = profileSettings(raw, profile);
  const wake = time(s, "routine.wake.time");
  const sleep = time(s, "routine.sleep.start");
  const awakeFrom = toMinutes(wake);
  const awakeTo = toMinutes(sleep) > awakeFrom ? toMinutes(sleep) : DAY_MINUTES;
  const awakeMinutes = awakeTo - awakeFrom;
  const blocks: RoutineBlockPlacement[] = [];
  const busy = [...taskRanges];
  let routineMinutes = 0;
  let unplaced = 0;

  for (const r of buildStarterRoutines(s)) {
    if (r.level === "off") continue;
    if (r.kind === "sleep") {
      blocks.push({
        id: r.id,
        routine: r.kind,
        level: r.level,
        blockKind: "fixed",
        day,
        profile,
        start: sleep,
        end: wake,
        durationMinutes: (toMinutes(wake) - toMinutes(sleep) + DAY_MINUTES) % DAY_MINUTES,
        placed: true,
      });
    } else if (r.window) {
      routineMinutes += r.window.durationMinutes;
      const window = {
        from: fromMinutes(Math.max(toMinutes(r.window.from), awakeFrom)),
        to: fromMinutes(Math.min(toMinutes(r.window.to), awakeTo)),
      };
      const slot =
        toMinutes(window.from) < toMinutes(window.to)
          ? placeFlexibleBlock({ window, durationMinutes: r.window.durationMinutes, busy })
          : null;
      if (slot) busy.push(slot);
      else unplaced += 1;
      blocks.push({
        id: r.id,
        routine: r.kind,
        level: r.level,
        blockKind: "flexible",
        day,
        profile,
        ...(slot ?? {}),
        durationMinutes: r.window.durationMinutes,
        placed: slot !== null,
      });
    }
  }
  return {
    profile,
    blocks,
    excessMinutes: Math.max(0, routineMinutes - awakeMinutes),
    unplaced,
  };
}

export interface WeekRoutinePlan {
  blocks: RoutineBlockPlacement[];
  routineOverloaded: boolean;
  routineOverloadMinutes: number;
}

/** Plans the seven days of a week; overloaded when routine hours do not fit or a block has no gap. */
export function planWeekRoutines(
  store: PlanStore,
  week: PlanWeek,
  raw: Record<string, unknown>,
): WeekRoutinePlan {
  const blocks: RoutineBlockPlacement[] = [];
  let overloadMinutes = 0;
  let unplacedCount = 0;
  for (let i = 0; i < WEEK_DAYS; i += 1) {
    const day = addDays(week.firstDay, i);
    const ranges = store
      .tasksOn(week.userId, day)
      .filter((t) => t.state !== "cancelled" && t.state !== "skipped" && t.window)
      .map((t) => t.window as MinuteRange);
    const plan = planRoutineBlocks(raw, day, ranges);
    blocks.push(...plan.blocks);
    overloadMinutes += plan.excessMinutes;
    unplacedCount += plan.unplaced;
    for (const b of plan.blocks)
      if (!b.placed && plan.excessMinutes === 0) overloadMinutes += b.durationMinutes;
  }
  return {
    blocks,
    routineOverloaded: overloadMinutes > 0 || unplacedCount > 0,
    routineOverloadMinutes: overloadMinutes,
  };
}
