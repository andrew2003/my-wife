import type { Task } from "@my-wife/contracts";
import { applyTaskAction } from "./checklist";
import type { ExpressionState } from "./expressions";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type TaskChipState = "done" | "upcoming" | "not_done";

/**
 * The chip of a checklist row, decided in code. A task that is still open after its
 * window ended (or from an earlier day) is "not done"; the clock is a parameter.
 * `today` is a `YYYY-MM-DD` date and `nowTime` an `HH:MM` time, both in the user zone.
 */
export function taskChipState(task: Task, today: string, nowTime: string): TaskChipState {
  if (task.state === "done") return "done";
  if (task.state !== "planned" && task.state !== "in_progress") return "not_done";
  if (task.day < today) return "not_done";
  if (task.day === today && task.window && task.window.end < nowTime) return "not_done";
  return "upcoming";
}

export interface DashboardProgress {
  done: number;
  total: number;
  percent: number;
}

/** Share of finished tasks; cancelled tasks do not count either way. */
export function dashboardProgress(tasks: Task[]): DashboardProgress {
  const counted = tasks.filter((t) => t.state !== "cancelled");
  const done = counted.filter((t) => t.state === "done").length;
  const total = counted.length;
  return { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
}

export interface DashboardReactionRef {
  key: string;
  params: Record<string, string | number>;
}

/** The reaction as shown: translated text and the expression state of its sticker. */
export interface DashboardReaction {
  text: string;
  state: ExpressionState;
}

export type CompleteResult =
  | { ok: true; tasks: Task[]; reaction: DashboardReactionRef }
  | { ok: false; tasks: Task[]; reaction: null };

/** Ticks a task as done. The reaction is built only after the server saved the change. */
export async function completeTask(
  taskId: string,
  tasks: Task[],
  doFetch: FetchLike = fetch,
): Promise<CompleteResult> {
  const res = await applyTaskAction("done", taskId, tasks, doFetch);
  if (!res.ok) return { ok: false, tasks: res.tasks, reaction: null };
  const title = res.tasks.find((t) => t.id === taskId)?.title ?? "";
  const { done, total } = dashboardProgress(res.tasks);
  return {
    ok: true,
    tasks: res.tasks,
    reaction: { key: "dashboard.reaction.task_done", params: { title, done, total } },
  };
}

/** Local `YYYY-MM-DD` and `HH:MM` of a moment in a time zone (the clock is a parameter). */
export function localDayAndTime(now: Date, timeZone: string): { day: string; time: string } {
  let zone = timeZone;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: zone });
  } catch {
    zone = "UTC";
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return {
    day: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
  };
}
