import {
  GetSettingsResponseSchema,
  RoutineLevelSchema,
  ScheduleWeekSchema,
  SETTINGS,
  UpdateSettingResponseSchema,
  type RoutineLevel,
} from "@my-wife/contracts";
import { z } from "zod";
import { weekDays } from "./week-planner";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const LEVEL_ORDER: readonly RoutineLevel[] = ["off", "remind", "track", "commit"];

/** Routine kinds that have a level setting in the registry. */
export const ROUTINE_LEVEL_KEYS = {
  sleep: "routine.sleep.level",
  wake: "routine.wake.level",
  meals: "routine.meals.level",
} as const;
export type RoutineName = keyof typeof ROUTINE_LEVEL_KEYS;

export const SLEEP_TIME_KEYS = ["routine.sleep.start", "routine.wake.time"] as const;
export const SLEEP_NUMBER_KEYS = [
  "routine.winddown_lead_minutes",
  "routine.bedtime_lead_minutes",
  "routine.wake_nudge_interval_minutes",
  "routine.wake_nudge_max",
  "routine.wake_grace_minutes",
  "routine.wake_photo_window_minutes",
  "routine.wake_second_check_minutes",
] as const;
export const SLEEP_KEYS = [...SLEEP_TIME_KEYS, ...SLEEP_NUMBER_KEYS] as const;
export type SleepKey = (typeof SLEEP_KEYS)[number];

export type RoutineSettingKey = (typeof ROUTINE_LEVEL_KEYS)[RoutineName] | SleepKey;

export interface RoutinesData {
  levels: Record<RoutineName, RoutineLevel>;
  sleep: Record<SleepKey, string | number>;
}

export type RoutinesResult =
  { status: "ready"; data: RoutinesData } | { status: "empty" } | { status: "error" };

export type SaveResult = { ok: true; direction: string; effectiveFrom: string } | { ok: false };

/** Lowering a level is loosening: it takes effect from the next week (spec 22, section 1). */
export function isLoosening(from: RoutineLevel, to: RoutineLevel): boolean {
  return LEVEL_ORDER.indexOf(to) < LEVEL_ORDER.indexOf(from);
}

/** Reads the routine settings; missing values fall back to the registry defaults. */
export async function loadRoutines(doFetch: FetchLike = fetch): Promise<RoutinesResult> {
  try {
    const res = await doFetch("/api/settings", { cache: "no-store" });
    if (!res.ok) return { status: "error" };
    const parsed = GetSettingsResponseSchema.safeParse(await res.json());
    if (!parsed.success || !parsed.data.ok) return { status: "error" };
    const { values } = parsed.data.data;
    const levels = {} as Record<RoutineName, RoutineLevel>;
    for (const name of Object.keys(ROUTINE_LEVEL_KEYS) as RoutineName[]) {
      const key = ROUTINE_LEVEL_KEYS[name];
      const level = RoutineLevelSchema.safeParse(values[key]);
      levels[name] = level.success ? level.data : SETTINGS[key].default;
    }
    const sleep = {} as Record<SleepKey, string | number>;
    for (const key of SLEEP_KEYS) {
      const value = values[key];
      sleep[key] =
        typeof value === "string" || typeof value === "number" ? value : SETTINGS[key].default;
    }
    if (Object.values(levels).every((l) => l === "off")) return { status: "empty" };
    return { status: "ready", data: { levels, sleep } };
  } catch {
    return { status: "error" };
  }
}

/**
 * Reads the first day of the current week and returns its seven days. Null when the week
 * cannot be read: the screen then hides the week strips instead of guessing.
 */
export async function loadRoutineWeek(doFetch: FetchLike = fetch): Promise<string[] | null> {
  try {
    const res = await doFetch("/api/weeks/current", { cache: "no-store" });
    if (!res.ok) return null;
    const parsed = z
      .object({ ok: z.literal(true), data: z.object({ week: ScheduleWeekSchema }) })
      .safeParse(await res.json());
    return parsed.success ? weekDays(parsed.data.data.week.firstDay) : null;
  } catch {
    return null;
  }
}

/** Saves one setting; identity answers the change direction and when it takes effect. */
export async function saveRoutineSetting(
  key: RoutineSettingKey,
  value: string | number,
  doFetch: FetchLike = fetch,
): Promise<SaveResult> {
  try {
    const res = await doFetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, value }),
    });
    if (!res.ok) return { ok: false };
    const parsed = UpdateSettingResponseSchema.safeParse(await res.json());
    if (!parsed.success || !parsed.data.ok) return { ok: false };
    return {
      ok: true,
      direction: parsed.data.data.direction,
      effectiveFrom: parsed.data.data.effectiveFrom,
    };
  } catch {
    return { ok: false };
  }
}
