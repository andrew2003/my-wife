import {
  RecurrenceSchema,
  ScheduleWeekSchema,
  SyncStatusResponseSchema,
  TaskSchema,
  type Task,
} from "@my-wife/contracts";
import { z } from "zod";
import { weekDays } from "./week-planner";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type ScheduleRecurrence = z.infer<typeof RecurrenceSchema>;
export type SyncLink = Extract<
  z.infer<typeof SyncStatusResponseSchema>,
  { ok: true }
>["data"]["links"][number];

export interface ScheduleData {
  week: z.infer<typeof ScheduleWeekSchema>;
  tasks: Task[];
  recurrences: ScheduleRecurrence[];
  /** Null when the sync status could not be read; the details then say "unknown". */
  sync: SyncLink[] | null;
}

export type ScheduleResult =
  { status: "ready"; data: ScheduleData } | { status: "empty" } | { status: "error" };

export type BlockStatus = "done" | "late" | "current" | "upcoming" | "closed";

const WeekEnvelope = z.object({
  ok: z.literal(true),
  data: z.object({ week: ScheduleWeekSchema }),
});
const ChecklistEnvelope = z.object({
  ok: z.literal(true),
  data: z.object({ tasks: z.array(TaskSchema) }),
});
const RecurrenceEnvelope = z.object({
  ok: z.literal(true),
  data: z.object({ recurrences: z.array(RecurrenceSchema) }),
});

const pad2 = (n: number) => String(n).padStart(2, "0");

/** The device-local calendar day (`YYYY-MM-DD`) of `now`; the user's zone, not UTC. */
export function localDate(now: Date): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/** The device-local time of day (`HH:MM`) of `now`. */
export function localHm(now: Date): string {
  return `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
}

/**
 * Where a block stands at `nowHm` on `today` (both in the user's zone). A planned block whose
 * window already ended, or that belongs to an earlier day, is late. Pure: the clock is a parameter.
 */
export function blockStatus(task: Task, today: string, nowHm: string): BlockStatus {
  if (task.state === "done") return "done";
  if (task.state === "in_progress") return "current";
  if (task.state !== "planned") return "closed";
  if (task.day < today) return "late";
  if (task.day > today) return "upcoming";
  if (!task.window) return "upcoming";
  if (task.window.end <= nowHm) return "late";
  if (task.window.start <= nowHm) return "current";
  return "upcoming";
}

export type RepeatDescription =
  | { key: "schedule.repeat.weekly"; weekdays: number[] }
  | { key: "schedule.repeat.monthly_day"; day: number }
  | { key: "schedule.repeat.lunar_day"; day: number }
  | { key: "schedule.repeat.unknown" };

/** Describes how a block repeats, or null for a one-off block. */
export function describeRepeat(
  task: Task,
  recurrences: ScheduleRecurrence[],
): RepeatDescription | null {
  if (!task.parentRecurrenceId) return null;
  const rec = recurrences.find((r) => r.id === task.parentRecurrenceId);
  if (!rec) return { key: "schedule.repeat.unknown" };
  const p = rec.pattern;
  if (p.type === "weekly") return { key: "schedule.repeat.weekly", weekdays: p.weekdays };
  if (p.type === "monthly_day") return { key: "schedule.repeat.monthly_day", day: p.day };
  return { key: "schedule.repeat.lunar_day", day: p.day };
}

/** Blocks of one day ordered by start time; blocks without a window come last. */
export function blocksOfDay(tasks: Task[], day: string): Task[] {
  return tasks
    .filter((t) => t.day === day)
    .sort((a, b) => (a.window?.start ?? "99:99").localeCompare(b.window?.start ?? "99:99"));
}

async function optional<T>(
  doFetch: FetchLike,
  url: string,
  parse: (body: unknown) => T | null,
): Promise<T | null> {
  try {
    const res = await doFetch(url, { cache: "no-store" });
    return res.ok ? parse(await res.json()) : null;
  } catch {
    return null;
  }
}

/** Reads the current week with its blocks, repeat rules and calendar sync status. */
export async function loadSchedule(doFetch: FetchLike = fetch): Promise<ScheduleResult> {
  try {
    const weekRes = await doFetch("/api/weeks/current", { cache: "no-store" });
    if (weekRes.status === 404) return { status: "empty" };
    if (!weekRes.ok) return { status: "error" };
    const week = WeekEnvelope.safeParse(await weekRes.json());
    if (!week.success) return { status: "error" };

    const lists = await Promise.all(
      weekDays(week.data.data.week.firstDay).map(async (day) => {
        const res = await doFetch(`/api/checklist?date=${encodeURIComponent(day)}`, {
          cache: "no-store",
        });
        const parsed = res.ok ? ChecklistEnvelope.safeParse(await res.json()) : null;
        return parsed?.success ? parsed.data.data.tasks : null;
      }),
    );
    if (lists.some((l) => l === null)) return { status: "error" };

    const [recurrences, sync] = await Promise.all([
      optional(doFetch, "/api/recurrences", (b) => {
        const r = RecurrenceEnvelope.safeParse(b);
        return r.success ? r.data.data.recurrences : null;
      }),
      optional(doFetch, "/api/sync/status", (b) => {
        const r = SyncStatusResponseSchema.safeParse(b);
        return r.success && r.data.ok ? r.data.data.links : null;
      }),
    ]);
    return {
      status: "ready",
      data: {
        week: week.data.data.week,
        tasks: lists.flat() as Task[],
        recurrences: recurrences ?? [],
        sync,
      },
    };
  } catch {
    return { status: "error" };
  }
}
