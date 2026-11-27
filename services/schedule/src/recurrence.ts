import type { PlanStore, PlanTask } from "./plan";
import { addDays } from "./week-plan";

/** Mirrors `RecurrencePatternSchema` in contracts. */
type Pattern =
  | { type: "weekly"; weekdays: number[] }
  | { type: "monthly_day"; day: number }
  | { type: "lunar_day"; day: number; month?: number };

/** A recurrence on the solar calendar; lunar ones are handled by the lunar conversion issue. */
export interface SolarRecurrence {
  id: string;
  calendar: "solar";
  pattern: Pattern;
  /** Solar dates (`YYYY-MM-DD`) on which the recurrence does not fire. */
  exceptions: string[];
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

export interface StoredRecurrence extends SolarRecurrence {
  userId: string;
  task: RecurrenceTaskTemplate;
}

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
 * Creates the `planned` instances of the user's solar recurrences for the seven days from
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
    for (const day of solarOccurrences(r, firstDay, lastDay)) {
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
