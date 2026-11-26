import { randomUUID } from "node:crypto";
import type { EventEnvelope } from "@my-wife/contracts";

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

export interface PlanWeek {
  id: string;
  userId: string;
  firstDay: string;
  state: WeekState;
  /** False until `week.closed` was published, so a failed publish is retried (never doubled). */
  closedAnnounced: boolean;
}

/** Port: the Drizzle store replaces the in-memory one without touching the logic below. */
export interface PlanStore {
  addTask(task: PlanTask): void;
  getTask(userId: string, taskId: string): PlanTask | undefined;
  tasksOn(userId: string, day: string): PlanTask[];
  addWeek(week: PlanWeek): void;
  getWeek(userId: string, weekId: string): PlanWeek | undefined;
  latestWeek(userId: string): PlanWeek | undefined;
  allWeeks(): PlanWeek[];
}

export function createMemoryPlanStore(): PlanStore {
  const tasks = new Map<string, PlanTask>();
  const weeks = new Map<string, PlanWeek>();
  return {
    addTask: (t) => void tasks.set(t.id, t),
    getTask: (userId, id) => {
      const t = tasks.get(id);
      return t && t.userId === userId ? t : undefined;
    },
    tasksOn: (userId, day) => [...tasks.values()].filter((t) => t.userId === userId && t.day === day),
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

export type TaskResult = { ok: true; task: PlanTask } | { ok: false; error: "not_in_plan" | "invalid_state" };

/** Start: only a task of this user that is still `planned` can be started. */
export async function startTask(deps: PlanDeps, userId: string, taskId: string): Promise<TaskResult> {
  const task = deps.store.getTask(userId, taskId);
  if (!task) return { ok: false, error: "not_in_plan" };
  if (task.state !== "planned") return { ok: false, error: "invalid_state" };
  const startedAt = deps.now().toISOString();
  await deps.publish(envelope(deps, `task-started-${task.id}-${task.carriedCount}`, "task.started", userId, { taskId, startedAt }));
  task.state = "in_progress";
  return { ok: true, task };
}

/** Tick done. A task ticked while still `planned` passes through `in_progress`. No chat message. */
export async function completeTask(deps: PlanDeps, userId: string, taskId: string): Promise<TaskResult> {
  const task = deps.store.getTask(userId, taskId);
  if (!task) return { ok: false, error: "not_in_plan" };
  if (task.state === "planned") {
    const started = await startTask(deps, userId, taskId);
    if (!started.ok) return started;
  } else if (task.state !== "in_progress") {
    return { ok: false, error: "invalid_state" };
  }
  const endedAt = deps.now().toISOString();
  await deps.publish(envelope(deps, `task-ended-${task.id}`, "task.ended", userId, { taskId, endedAt }));
  task.state = "done";
  return { ok: true, task };
}

export function createWeek(deps: PlanDeps, userId: string, firstDay: string): PlanWeek {
  const week: PlanWeek = { id: randomUUID(), userId, firstDay, state: "draft", closedAnnounced: false };
  deps.store.addWeek(week);
  return week;
}

export type ApproveResult = { ok: true; week: PlanWeek } | { ok: false; error: "not_found" | "not_draft" };

export async function approveWeek(deps: PlanDeps, userId: string, weekId: string): Promise<ApproveResult> {
  const week = deps.store.getWeek(userId, weekId);
  if (!week) return { ok: false, error: "not_found" };
  if (week.state !== "draft") return { ok: false, error: "not_draft" };
  await deps.publish(
    envelope(deps, `week-planned-${week.id}`, "week.planned", userId, { weekId: week.id, firstDay: week.firstDay }),
  );
  week.state = "planned";
  return { ok: true, week };
}

/**
 * Idempotent boundary job. Moves weeks along planned -> active -> reviewing and announces
 * `week.closed` once per week; a failed publish keeps the week unannounced for the next run.
 */
export async function runWeekBoundary(deps: PlanDeps): Promise<{ closed: string[]; failed: string[] }> {
  const nowMs = deps.now().getTime();
  const result = { closed: [] as string[], failed: [] as string[] };
  for (const week of deps.store.allWeeks()) {
    const first = startOfDay(week.firstDay);
    if (week.state === "planned" && nowMs >= first) week.state = "active";
    if (week.state === "active" && nowMs >= first + WEEK_DAYS * DAY_MS) week.state = "reviewing";
    if (week.state !== "reviewing" || week.closedAnnounced) continue;
    try {
      await deps.publish(
        envelope(deps, `week-closed-${week.id}`, "week.closed", week.userId, {
          weekId: week.id,
          firstDay: week.firstDay,
          weekIndexInCycle: null,
        }),
      );
      week.closedAnnounced = true;
      result.closed.push(week.id);
    } catch {
      result.failed.push(week.id);
    }
  }
  return result;
}
