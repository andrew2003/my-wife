import type { WeekdaySchema } from "@my-wife/contracts";

type Weekday = (typeof WeekdaySchema)["_output"];

const WEEKDAYS: Weekday[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The local calendar date (YYYY-MM-DD) on which the week containing `at` started, in the user's
 * time zone with the user's first day of the week. Used as the key of the weekly reason quota.
 */
export function localWeekStart(at: Date, timeZone: string, weekStartDay: Weekday): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  // The local date as a UTC midnight, so plain day arithmetic works.
  const localMidnight = Date.UTC(get("year"), get("month") - 1, get("day"));
  const weekday = new Date(localMidnight).getUTCDay();
  const back = (weekday - WEEKDAYS.indexOf(weekStartDay) + 7) % 7;
  return new Date(localMidnight - back * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Whether a reason counts as honest or as silence. A reason is honest while the user has used
 * fewer than `quota` honest reasons of this type this week; past that it counts as silence.
 * Only code decides this: the user's pick alone judges honesty and no AI label is involved.
 */
export function decideReasonOutcome(quota: number, usedThisWeek: number): "honest" | "silence" {
  return usedThisWeek < quota ? "honest" : "silence";
}
