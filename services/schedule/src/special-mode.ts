import { randomUUID } from "node:crypto";
import { SETTINGS, type EventEnvelope } from "@my-wife/contracts";
import { todayOf } from "./carry-over";
import { zonedInstant, zoneSetting } from "./review";
import { addDays } from "./week-plan";

export type SpecialModeKind = "sick" | "travel" | "holiday";

export interface SpecialModePeriod {
  id: string;
  userId: string;
  kind: SpecialModeKind;
  /** First and last covered local day (inclusive), in the user's time zone. */
  fromDay: string;
  toDay: string;
  /** UTC instants: start of `fromDay` and the start of the day after `toDay` (exclusive end). */
  from: string;
  to: string;
  retroactive: boolean;
  reason?: string;
  createdAt: string;
  endedAnnounced: boolean;
}

export interface SpecialModeSettings {
  daysPerCycle: number;
  retroactiveHours: number;
  cycleDays: number;
  zone: string;
}

const nonNeg = (v: unknown, fallback: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : fallback;

/** Every limit is a user setting; invalid values fall back to the registry default. */
export function resolveSpecialModeSettings(values: Record<string, unknown>): SpecialModeSettings {
  const weeks = values["budget.cycle_weeks"];
  const cycleWeeks =
    typeof weeks === "number" && Number.isInteger(weeks) && weeks > 0
      ? weeks
      : (SETTINGS["budget.cycle_weeks"].default as number);
  return {
    daysPerCycle: nonNeg(
      values["schedule.special_mode_days_per_cycle"],
      SETTINGS["schedule.special_mode_days_per_cycle"].default as number,
    ),
    retroactiveHours: nonNeg(
      values["schedule.sick_retroactive_hours"],
      SETTINGS["schedule.sick_retroactive_hours"].default as number,
    ),
    cycleDays: cycleWeeks * 7,
    zone: zoneSetting(values["calendar.time_zone"]),
  };
}

/** Local days from `fromDay` to `toDay`, inclusive. */
export function daysBetween(fromDay: string, toDay: string): string[] {
  const out: string[] = [];
  for (let d = fromDay; d <= toDay; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Start of a local day as a UTC instant. */
export function dayStart(day: string, zone: string): Date {
  const [y, mo, d] = day.split("-").map(Number);
  return new Date(zonedInstant(y!, mo!, d!, 0, 0, zone));
}

const DAY_MS = 86_400_000;
const dayNumber = (day: string) => Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY_MS);

/**
 * The cycle a day belongs to, named by its first day. Boundaries are projected by `cycleDays`
 * from the nearest known cycle first day (the closest earlier one, else the earliest later one),
 * so days outside the known cycles still fall into cycle-length windows. Without any known cycle
 * the windows are anchored at 1970-01-01.
 */
export function cycleKeyOf(day: string, cycleFirstDays: string[], cycleDays: number): string {
  const sorted = [...cycleFirstDays].sort();
  const anchor = sorted.filter((f) => f <= day).pop() ?? sorted[0] ?? "1970-01-01";
  const offset = dayNumber(day) - dayNumber(anchor);
  return addDays(anchor, Math.floor(offset / cycleDays) * cycleDays);
}

export type PlanResult =
  | { ok: true; period: Omit<SpecialModePeriod, "id" | "userId" | "endedAnnounced"> }
  | { ok: false; code: string };

export interface PlanInput {
  kind: SpecialModeKind;
  fromDay: string;
  toDay: string;
  reason?: string;
  now: Date;
  settings: SpecialModeSettings;
  cycleFirstDays: string[];
  existing: Pick<SpecialModePeriod, "fromDay" | "toDay">[];
}

/**
 * Decides whether a period may be activated (spec 20 section 6; defaults in docs/decisions.md).
 * Pure: time is a parameter.
 */
export function planPeriod(input: PlanInput): PlanResult {
  const { kind, fromDay, toDay, now, settings } = input;
  if (toDay < fromDay) return { ok: false, code: "schedule.special_mode_invalid_range" };
  // Reject before walking the days: a range longer than the quota can never fit.
  const length = dayNumber(toDay) - dayNumber(fromDay) + 1;
  if (length > settings.daysPerCycle) {
    return { ok: false, code: "schedule.special_mode_quota_exceeded" };
  }
  const today = todayOf(now, settings.zone);
  const retroactive = fromDay < today;
  const reason = input.reason?.trim();
  if (retroactive) {
    // Only sick mode may look back, and only inside the window counted from the request time.
    if (kind !== "sick") return { ok: false, code: "schedule.special_mode_not_retroactive" };
    if (!reason) return { ok: false, code: "schedule.special_mode_reason_required" };
    const oldestEnd = dayStart(addDays(fromDay, 1), settings.zone).getTime();
    if (oldestEnd < now.getTime() - settings.retroactiveHours * 3_600_000) {
      return { ok: false, code: "schedule.special_mode_window_exceeded" };
    }
  }
  if (input.existing.some((p) => p.fromDay <= toDay && fromDay <= p.toDay)) {
    return { ok: false, code: "schedule.special_mode_overlap" };
  }
  // The quota is per cycle day: a period that spans two cycles is split between them.
  const used = new Map<string, number>();
  const count = (day: string) => {
    const k = cycleKeyOf(day, input.cycleFirstDays, settings.cycleDays);
    used.set(k, (used.get(k) ?? 0) + 1);
  };
  for (const p of input.existing) daysBetween(p.fromDay, p.toDay).forEach(count);
  daysBetween(fromDay, toDay).forEach(count);
  if ([...used.values()].some((n) => n > settings.daysPerCycle)) {
    return { ok: false, code: "schedule.special_mode_quota_exceeded" };
  }
  return {
    ok: true,
    period: {
      kind,
      fromDay,
      toDay,
      from: dayStart(fromDay, settings.zone).toISOString(),
      to: dayStart(addDays(toDay, 1), settings.zone).toISOString(),
      retroactive,
      ...(reason ? { reason } : {}),
      createdAt: now.toISOString(),
    },
  };
}

/** Whether the instant lies in the period window (inclusive start, exclusive end). */
export function covers(p: Pick<SpecialModePeriod, "from" | "to">, occurredAt: string): boolean {
  const t = Date.parse(occurredAt);
  return Date.parse(p.from) <= t && t < Date.parse(p.to);
}

export function startedEvent(p: SpecialModePeriod): EventEnvelope<"special_mode.started"> {
  return {
    id: `special-mode-started-${p.id}`,
    type: "special_mode.started",
    occurredAt: p.createdAt,
    userId: p.userId,
    schemaVersion: 1,
    payload: { periodId: p.id, kind: p.kind, from: p.from, to: p.to, retroactive: p.retroactive },
  } as EventEnvelope<"special_mode.started">;
}

export function endedEvent(p: SpecialModePeriod, now: Date): EventEnvelope<"special_mode.ended"> {
  return {
    id: `special-mode-ended-${p.id}`,
    type: "special_mode.ended",
    occurredAt: now.toISOString(),
    userId: p.userId,
    schemaVersion: 1,
    payload: { periodId: p.id },
  } as EventEnvelope<"special_mode.ended">;
}

export const newPeriodId = () => randomUUID();
