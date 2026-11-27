import { SETTINGS } from "@my-wife/contracts";

export type BreakKind = "break" | "long_break";

/** User-configurable pomodoro lengths (`schedule.pomodoro_*`); never hard-coded. */
export interface PomodoroSettings {
  workMinutes: number;
  shortMinutes: number;
  longMinutes: number;
  longEvery: number;
}

export interface BreakPlan {
  kind: BreakKind;
  minutes: number;
}

/** Pure: the break that follows the `completedCount`-th completed pomodoro (1-based). */
export function planBreak(
  completedCount: number,
  s: Pick<PomodoroSettings, "shortMinutes" | "longMinutes" | "longEvery">,
): BreakPlan {
  const long = completedCount > 0 && completedCount % s.longEvery === 0;
  return long
    ? { kind: "long_break", minutes: s.longMinutes }
    : { kind: "break", minutes: s.shortMinutes };
}

const KEYS = {
  workMinutes: "schedule.pomodoro_work_minutes",
  shortMinutes: "schedule.pomodoro_break_minutes",
  longMinutes: "schedule.pomodoro_long_break_minutes",
  longEvery: "schedule.pomodoro_long_break_every",
} as const;

/** Reads each value from the answers; invalid or missing values fall back to the registry default. */
export function resolvePomodoroSettings(answers: Record<string, unknown>): PomodoroSettings {
  const pick = (key: (typeof KEYS)[keyof typeof KEYS]): number => {
    const v = answers[key];
    return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : SETTINGS[key].default;
  };
  return {
    workMinutes: pick(KEYS.workMinutes),
    shortMinutes: pick(KEYS.shortMinutes),
    longMinutes: pick(KEYS.longMinutes),
    longEvery: pick(KEYS.longEvery),
  };
}
