import type { PlanStore, PlanTask } from "./plan";
import { solarToLunar } from "./lunar";
import { addDays } from "./week-plan";

/** Mirrors `RecurrencePatternSchema` in contracts. */
type Pattern =
  | { type: "weekly"; weekdays: number[] }
  | { type: "monthly_day"; day: number }
  | { type: "lunar_day"; day: number; month?: number };

/** A recurrence on the solar calendar. */
export interface SolarRecurrence {
  id: string;
  calendar: "solar";
  pattern: Pattern;
  /** Solar dates (`YYYY-MM-DD`) on which the recurrence does not fire. */
  exceptions: string[];
}

/** A recurrence on the lunar calendar (`lunar_day` pattern). */
export interface LunarRecurrence {
  id: string;
  calendar: "lunar";
  pattern: Extract<Pattern, { type: "lunar_day" }>;
  /** Solar dates (`YYYY-MM-DD`) on which the recurrence does not fire. */
  exceptions: string[];
  /**
   * When the pattern names a month, also fire in that month's leap twin. Off by default: a
   * leap-month anniversary uses the non-leap month of the same number. Without a month, the
   * recurrence fires in every lunar month, leap ones included.
   */
  includeLeapMonth?: boolean;
}

/** The task fields copied onto every instance. */
export type RecurrenceTaskTemplate = Omit<
  PlanTask,
  | "id"
  | "userId"
  | "day"
  | "state"
  | "carriedCount"
  | "priority"
  | "pendingAsk"
  | "parentRecurrenceId"
>;

export type StoredRecurrence = (SolarRecurrence | LunarRecurrence) & {
  userId: string;
  task: RecurrenceTaskTemplate;
};

const daysInMonth = (year: number, month: number): number =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * Pure: the solar dates in `[from, to]` (inclusive, `YYYY-MM-DD`) on which the recurrence fires.
 * Weekdays are numbered 0 (Sunday) to 6 (Saturday). A monthly day beyond the end of a short month
 * fires on that month's last day.
 */
export function solarOccurrences(recurrence: SolarRecurrence, from: string, to: string): string[] {
  if (recurrence.calendar !== "solar") return [];
  const out: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    if (recurrence.exceptions.includes(day)) continue;
    const date = new Date(`${day}T00:00:00Z`);
    const { pattern } = recurrence;
    if (pattern.type === "weekly") {
      if (pattern.weekdays.includes(date.getUTCDay())) out.push(day);
    } else if (pattern.type === "monthly_day") {
      const target = Math.min(
        pattern.day,
        daysInMonth(date.getUTCFullYear(), date.getUTCMonth() + 1),
      );
      if (date.getUTCDate() === target) out.push(day);
    }
  }
  return out;
}

/**
 * Pure: the solar dates in `[from, to]` (inclusive) on which a lunar recurrence fires. Day 30 in a
 * 29-day lunar month fires on that month's last day. Throws `LunarRangeError` outside the
 * supported years.
 */
export function lunarOccurrences(recurrence: LunarRecurrence, from: string, to: string): string[] {
  if (recurrence.calendar !== "lunar" || recurrence.pattern.type !== "lunar_day") return [];
  const { day: target, month } = recurrence.pattern;
  const out: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    if (recurrence.exceptions.includes(day)) continue;
    const lunar = solarToLunar(day);
    if (month !== undefined && lunar.month !== month) continue;
    if (month !== undefined && lunar.leap && !recurrence.includeLeapMonth) continue;
    const isLastDay = solarToLunar(addDays(day, 1)).day === 1;
    if (lunar.day === target || (isLastDay && lunar.day < target)) out.push(day);
  }
  return out;
}

const occurrencesOf = (r: StoredRecurrence, from: string, to: string): string[] =>
  r.calendar === "lunar" ? lunarOccurrences(r, from, to) : solarOccurrences(r, from, to);

/**
 * Creates the `planned` instances of the user's recurrences for the seven days from
 * `firstDay`, skipping days before `today` (the user's local date). Planning twice adds nothing:
 * a day that already holds an instance of the recurrence is left alone.
 */
export function materializeWeekRecurrences(
  store: PlanStore,
  recurrences: StoredRecurrence[],
  userId: string,
  firstDay: string,
  today: string,
  newId: () => string,
): PlanTask[] {
  const lastDay = addDays(firstDay, 6);
  const created: PlanTask[] = [];
  for (const r of recurrences.filter((x) => x.userId === userId)) {
    for (const day of occurrencesOf(r, firstDay, lastDay)) {
      if (day < today) continue;
      if (store.tasksOn(userId, day).some((t) => t.parentRecurrenceId === r.id)) continue;
      const task: PlanTask = {
        ...r.task,
        id: newId(),
        userId,
        day,
        state: "planned",
        carriedCount: 0,
        priority: "normal",
        pendingAsk: null,
        parentRecurrenceId: r.id,
      };
      store.addTask(task);
      created.push(task);
    }
  }
  return created;
}
