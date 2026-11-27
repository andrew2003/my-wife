import { SETTINGS } from "@my-wife/contracts";
import type { RoutineLevel } from "./routines";

export interface LatenessInput {
  level: RoutineLevel;
  graceMinutes: number;
  minutesLate: number;
}

export interface LatenessResult {
  /** `track` and `commit` keep the check-in for the weekly review. */
  recordCheckin: boolean;
  /** Only at `commit`, and only strictly after the grace period (spec 22 sections 1 and 3). */
  fault: boolean;
}

/** Pure lateness rule; the caller passes the minutes measured from hard timestamps. */
export function evaluateLateness(input: LatenessInput): LatenessResult {
  const recordCheckin = input.level === "track" || input.level === "commit";
  const fault = input.level === "commit" && input.minutesLate > input.graceMinutes;
  return { recordCheckin, fault };
}

/** `routine.wake_grace_minutes`; an invalid value falls back to the registry default. */
export function wakeGraceMinutes(raw: Record<string, unknown>): number {
  const v = raw["routine.wake_grace_minutes"];
  return typeof v === "number" && Number.isInteger(v) && v >= 0
    ? v
    : (SETTINGS["routine.wake_grace_minutes"].default as number);
}
