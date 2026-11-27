import { SETTINGS, TimeOfDaySchema } from "@my-wife/contracts";
import type { PlanStore, PlanTask, PlanWeek } from "./plan";

const WEEK_DAYS = 7;
const DAY_MS = 86_400_000;
const DAY_MINUTES = 24 * 60;

export interface TemplateTask extends Omit<
  PlanTask,
  "id" | "userId" | "day" | "state" | "carriedCount" | "priority" | "pendingAsk"
> {
  /** 0 is the first day of the week. */
  dayOffset: number;
}

export interface WeekTemplate {
  id: string;
  userId: string;
  name: string;
  tasks: TemplateTask[];
}

export const addDays = (isoDay: string, days: number): string =>
  new Date(Date.parse(`${isoDay}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

const toMinutes = (t: string): number => {
  const [h, m] = t.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

function timeSetting(
  values: Record<string, unknown>,
  key: "routine.wake.time" | "routine.sleep.start",
) {
  const parsed = TimeOfDaySchema.safeParse(values[key]);
  return toMinutes(parsed.success ? parsed.data : (SETTINGS[key].default as string));
}

/** Minutes a day offers for tasks: the span between the wake time and the sleep start. */
export function awakeMinutesPerDay(values: Record<string, unknown>): number {
  const wake = timeSetting(values, "routine.wake.time");
  const sleep = timeSetting(values, "routine.sleep.start");
  return (sleep - wake + DAY_MINUTES) % DAY_MINUTES;
}

export interface WeekLoad {
  plannedMinutes: number;
  availableMinutes: number;
  overloaded: boolean;
  overloadMinutes: number;
}

/** Pure: the week is overloaded when its estimates exceed the awake minutes of its seven days. */
export function computeWeekLoad(
  store: PlanStore,
  week: PlanWeek,
  values: Record<string, unknown>,
): WeekLoad {
  let plannedMinutes = 0;
  for (let i = 0; i < WEEK_DAYS; i += 1) {
    for (const t of store.tasksOn(week.userId, addDays(week.firstDay, i))) {
      if (t.state !== "cancelled" && t.state !== "skipped") plannedMinutes += t.estimatedMinutes;
    }
  }
  const availableMinutes = awakeMinutesPerDay(values) * WEEK_DAYS;
  const overloadMinutes = Math.max(0, plannedMinutes - availableMinutes);
  return { plannedMinutes, availableMinutes, overloaded: overloadMinutes > 0, overloadMinutes };
}

/** Copies the template tasks into the week as `planned` tasks with fresh ids. */
export function copyTemplateIntoWeek(
  store: PlanStore,
  week: PlanWeek,
  template: WeekTemplate,
  newId: () => string,
): PlanTask[] {
  return template.tasks.map(({ dayOffset, ...rest }) => {
    const task: PlanTask = {
      ...rest,
      id: newId(),
      userId: week.userId,
      day: addDays(week.firstDay, dayOffset),
      state: "planned",
      carriedCount: 0,
      priority: "normal",
      pendingAsk: null,
    };
    store.addTask(task);
    return task;
  });
}
