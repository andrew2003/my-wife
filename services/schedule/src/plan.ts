import { randomUUID } from "node:crypto";
import type { EventEnvelope, WeekPlannedItem } from "@my-wife/contracts";

export type WeekState = "draft" | "planned" | "active" | "reviewing" | "closed";
export type TaskState = "planned" | "in_progress" | "done" | "skipped" | "carried" | "cancelled";

export interface PlanTask {
  id: string;
  userId: string;
  title: string;
  day: string;
  window: { start: string; end: string } | null;
  estimatedMinutes: number;
  energyLevel: "low" | "medium" | "high" | null;
  definitionOfDone: string | null;
  monitoringProfile: "none" | "checklist_only" | "camera" | "offline_checkin";
  kind: "desk" | "offline" | "money";
  state: TaskState;
  carriedCount: number;
  parentRecurrenceId: string | null;
}

export interface PlanSubtask {
  id: string;
  userId: string;
  taskId: string;
  title: string;
  done: boolean;
}

export interface PlanWeek {
  id: string;
  userId: string;
  firstDay: string;
  state: WeekState;
  /** Claimed before `week.closed` is published and released on failure, so it is sent once. */
  closedAnnounced: boolean;
  /** Claimed before `review.ready` is published and released on failure. */
  reviewAnnounced: boolean;
}

/** Port: the Drizzle store replaces the in-memory one without touching the logic below. */
export interface PlanStore {
  addTask(task: PlanTask): void;
  getTask(userId: string, taskId: string): PlanTask | undefined;
  tasksOn(userId: string, day: string): PlanTask[];
  addSubtask(subtask: PlanSubtask): void;
  getSubtask(userId: string, subtaskId: string): PlanSubtask | undefined;
  subtasksOf(userId: string, taskId: string): PlanSubtask[];
  addWeek(week: PlanWeek): void;
  getWeek(userId: string, weekId: string): PlanWeek | undefined;
  latestWeek(userId: string): PlanWeek | undefined;
  allWeeks(): PlanWeek[];
}

export function createMemoryPlanStore(): PlanStore {
  const tasks = new Map<string, PlanTask>();
  const weeks = new Map<string, PlanWeek>();
  const subtasks = new Map<string, PlanSubtask>();
  return {
    addSubtask: (s) => void subtasks.set(s.id, s),
    getSubtask: (userId, id) => {
      const s = subtasks.get(id);
      return s && s.userId === userId ? s : undefined;
    },
    subtasksOf: (userId, taskId) =>
      [...subtasks.values()].filter((s) => s.userId === userId && s.taskId === taskId),
    addTask: (t) => void tasks.set(t.id, t),
    getTask: (userId, id) => {
      const t = tasks.get(id);
      return t && t.userId === userId ? t : undefined;
    },
    tasksOn: (userId, day) =>
      [...tasks.values()].filter((t) => t.userId === userId && t.day === day),
    addWeek: (w) => void weeks.set(w.id, w),
    getWeek: (userId, id) => {
      const w = weeks.get(id);
      return w && w.userId === userId ? w : undefined;
    },
    latestWeek: (userId) =>
      [...weeks.values()]
        .filter((w) => w.userId === userId)
        .sort((a, b) => b.firstDay.localeCompare(a.firstDay))[0],
    allWeeks: () => [...weeks.values()],
  };
}

export type Publish = (event: EventEnvelope) => void | Promise<void>;
export interface PlanDeps {
  store: PlanStore;
  publish: Publish;
  now: () => Date;
}

const DAY_MS = 86_400_000;
const WEEK_DAYS = 7;

const startOfDay = (isoDay: string) => Date.parse(`${isoDay}T00:00:00Z`);

function envelope(deps: PlanDeps, id: string, type: string, userId: string, payload: unknown) {
  return {
    id,
    type,
    occurredAt: deps.now().toISOString(),
    userId,
    schemaVersion: 1,
    payload,
  } as EventEnvelope;
}

export type TaskResult =
  { ok: true; task: PlanTask } | { ok: false; error: "not_in_plan" | "invalid_state" | "subtasks_open" };

/**
 * Start: only a task of this user that is still `planned` can be started. The state is claimed
 * before the publish so concurrent calls emit once; a failed publish rolls the claim back.
 */
export async function startTask(
  deps: PlanDeps,
  userId: string,
  taskId: string,
): Promise<TaskResult> {
  const task = deps.store.getTask(userId, taskId);
  if (!task) return { ok: false, error: "not_in_plan" };
  if (task.state !== "planned") return { ok: false, error: "invalid_state" };
  task.state = "in_progress";
  try {
    await publishStarted(deps, task);
  } catch (err) {
    task.state = "planned";
    throw err;
  }
  return { ok: true, task };
}

async function publishStarted(deps: PlanDeps, task: PlanTask) {
  const startedAt = deps.now().toISOString();
  await deps.publish(
    envelope(deps, `task-started-${task.id}-${task.carriedCount}`, "task.started", task.userId, {
      taskId: task.id,
      startedAt,
    }),
  );
}

/** Tick done. A task ticked while still `planned` passes through `in_progress`. No chat message. */
export async function completeTask(
  deps: PlanDeps,
  userId: string,
  taskId: string,
): Promise<TaskResult> {
  const task = deps.store.getTask(userId, taskId);
  if (!task) return { ok: false, error: "not_in_plan" };
  const from = task.state;
  if (from !== "planned" && from !== "in_progress") return { ok: false, error: "invalid_state" };
  // The parent can be completed only when every sub-task is done.
  if (deps.store.subtasksOf(userId, taskId).some((s) => !s.done))
    return { ok: false, error: "subtasks_open" };
  task.state = "done";
  try {
    if (from === "planned") await publishStarted(deps, task);
    const endedAt = deps.now().toISOString();
    await deps.publish(
      envelope(deps, `task-ended-${task.id}`, "task.ended", userId, { taskId, endedAt }),
    );
  } catch (err) {
    task.state = from;
    throw err;
  }
  return { ok: true, task };
}

export function createWeek(deps: PlanDeps, userId: string, firstDay: string): PlanWeek {
  const week: PlanWeek = {
    id: randomUUID(),
    userId,
    firstDay,
    state: "draft",
    closedAnnounced: false,
    reviewAnnounced: false,
  };
  deps.store.addWeek(week);
  return week;
}

export type ApproveResult =
  { ok: true; week: PlanWeek } | { ok: false; error: "not_found" | "not_draft" };

export async function approveWeek(
  deps: PlanDeps,
  userId: string,
  weekId: string,
  plannedItems?: WeekPlannedItem[],
): Promise<ApproveResult> {
  const week = deps.store.getWeek(userId, weekId);
  if (!week) return { ok: false, error: "not_found" };
  if (week.state !== "draft") return { ok: false, error: "not_draft" };
  week.state = "planned";
  try {
    await deps.publish(
      envelope(deps, `week-planned-${week.id}`, "week.planned", userId, {
        weekId: week.id,
        firstDay: week.firstDay,
        ...(plannedItems && plannedItems.length > 0 ? { plannedItems } : {}),
      }),
    );
  } catch (err) {
    week.state = "draft";
    throw err;
  }
  return { ok: true, week };
}

/**
 * Idempotent boundary job. Moves weeks along planned -> active -> reviewing and announces
 * `week.closed` once per week; a failed publish keeps the week unannounced for the next run.
 */
export async function runWeekBoundary(
  deps: PlanDeps,
): Promise<{ closed: string[]; failed: string[] }> {
  const nowMs = deps.now().getTime();
  const result = { closed: [] as string[], failed: [] as string[] };
  for (const week of deps.store.allWeeks()) {
    const first = startOfDay(week.firstDay);
    if (week.state === "planned" && nowMs >= first) week.state = "active";
    if (week.state === "active" && nowMs >= first + WEEK_DAYS * DAY_MS) week.state = "reviewing";
    if (week.state !== "reviewing" || week.closedAnnounced) continue;
    // Claim before publishing so an overlapping run skips this week; roll back on failure.
    week.closedAnnounced = true;
    try {
      await deps.publish(
        envelope(deps, `week-closed-${week.id}`, "week.closed", week.userId, {
          weekId: week.id,
          firstDay: week.firstDay,
          weekIndexInCycle: null,
        }),
      );
      result.closed.push(week.id);
    } catch {
      week.closedAnnounced = false;
      result.failed.push(week.id);
    }
  }
  return result;
}
