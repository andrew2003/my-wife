import { randomUUID } from "node:crypto";
import type { EventEnvelope } from "@my-wife/contracts";
import { startTask, type PlanDeps } from "./plan";
import { planBreak, type BreakKind, type BreakPlan, type PomodoroSettings } from "./pomodoro";

const MINUTE_MS = 60_000;

/**
 * A work session. The server owns both timestamps: the client clock is never trusted, and the
 * remaining time is always derived from `startedAt` and `durationMinutes`, never stored.
 */
export interface WorkSession {
  id: string;
  userId: string;
  taskId: string;
  /** UTC ISO time recorded by the server when the session started. */
  startedAt: string;
  durationMinutes: number;
  /** UTC ISO time; set when the planned end is reached or the user stops early. */
  endedAt: string | null;
  /** Claimed before `session.ended` is published, released on failure, so it is sent once. */
  endAnnounced: boolean;
  /** Break that follows if the pomodoro runs to its planned end; fixed at start from user settings. */
  pomodoroBreak: BreakPlan;
}

/** Port: the Drizzle store replaces the in-memory one without touching the logic below. */
export interface SessionStore {
  add(session: WorkSession): void;
  get(userId: string, id: string): WorkSession | undefined;
  activeForTask(userId: string, taskId: string): WorkSession | undefined;
  all(): WorkSession[];
}

export function createMemorySessionStore(): SessionStore {
  const sessions = new Map<string, WorkSession>();
  return {
    add: (s) => void sessions.set(s.id, s),
    get: (userId, id) => {
      const s = sessions.get(id);
      return s && s.userId === userId ? s : undefined;
    },
    activeForTask: (userId, taskId) =>
      [...sessions.values()].find(
        (s) => s.userId === userId && s.taskId === taskId && s.endedAt === null,
      ),
    all: () => [...sessions.values()],
  };
}

export interface SessionDeps {
  plan: PlanDeps;
  sessions: SessionStore;
}

export interface SessionView {
  id: string;
  taskId: string;
  startedAt: string;
  durationMinutes: number;
  endedAt: string | null;
  plannedEndAt: string;
  remainingSeconds: number;
  phase: "work" | "break" | "done";
  /** True during the break that follows a completed pomodoro; this is never a fault. */
  monitoringPaused: boolean;
  break: {
    kind: BreakKind;
    startedAt: string;
    endsAt: string;
    remainingSeconds: number;
  } | null;
  /** Server time of this response; clients use it to correct their own clock offset. */
  serverNow: string;
}

const plannedEndMs = (s: WorkSession) => Date.parse(s.startedAt) + s.durationMinutes * MINUTE_MS;

const completedNaturally = (s: WorkSession) =>
  s.endedAt !== null && Date.parse(s.endedAt) >= plannedEndMs(s);

/** Derives the remaining time from the stored start and duration at `now`. */
export function viewSession(s: WorkSession, now: Date): SessionView {
  const breakStartMs = plannedEndMs(s);
  const breakEndMs = breakStartMs + s.pomodoroBreak.minutes * MINUTE_MS;
  const reached = now.getTime() >= breakStartMs;
  const stoppedEarly = s.endedAt !== null && !completedNaturally(s);
  const hasBreak = reached && !stoppedEarly;
  const onBreak = hasBreak && now.getTime() < breakEndMs;
  return {
    phase: onBreak ? "break" : hasBreak || stoppedEarly ? "done" : "work",
    monitoringPaused: onBreak,
    break: hasBreak
      ? {
          kind: s.pomodoroBreak.kind,
          startedAt: new Date(breakStartMs).toISOString(),
          endsAt: new Date(breakEndMs).toISOString(),
          remainingSeconds: Math.max(0, Math.ceil((breakEndMs - now.getTime()) / 1000)),
        }
      : null,
    id: s.id,
    taskId: s.taskId,
    startedAt: s.startedAt,
    durationMinutes: s.durationMinutes,
    endedAt: s.endedAt,
    plannedEndAt: new Date(plannedEndMs(s)).toISOString(),
    serverNow: now.toISOString(),
    remainingSeconds: s.endedAt
      ? 0
      : Math.max(0, Math.ceil((plannedEndMs(s) - now.getTime()) / 1000)),
  };
}

function envelope(
  deps: PlanDeps,
  id: string,
  type: string,
  userId: string,
  payload: unknown,
): EventEnvelope {
  return {
    id,
    type,
    occurredAt: deps.now().toISOString(),
    userId,
    schemaVersion: 1,
    payload,
  } as EventEnvelope;
}

export type StartSessionResult =
  | { ok: true; session: WorkSession }
  | { ok: false; error: "not_in_plan" | "invalid_state" | "already_active" };

/** Starts a session on a task; a still `planned` task is started first (`task.started`). */
export async function startSession(
  deps: SessionDeps,
  userId: string,
  taskId: string,
  durationMinutes: number,
  pomodoro: Pick<PomodoroSettings, "shortMinutes" | "longMinutes" | "longEvery">,
): Promise<StartSessionResult> {
  const task = deps.plan.store.getTask(userId, taskId);
  if (!task) return { ok: false, error: "not_in_plan" };
  if (deps.sessions.activeForTask(userId, taskId)) return { ok: false, error: "already_active" };
  if (task.state === "planned") {
    const started = await startTask(deps.plan, userId, taskId);
    if (!started.ok) return { ok: false, error: "invalid_state" };
  } else if (task.state !== "in_progress") {
    return { ok: false, error: "invalid_state" };
  }
  const completed = deps.sessions
    .all()
    .filter((o) => o.userId === userId && o.taskId === taskId && completedNaturally(o)).length;
  const session: WorkSession = {
    id: randomUUID(),
    userId,
    taskId,
    startedAt: deps.plan.now().toISOString(),
    durationMinutes,
    endedAt: null,
    endAnnounced: false,
    pomodoroBreak: planBreak(completed + 1, pomodoro),
  };
  deps.sessions.add(session);
  await deps.plan.publish(
    envelope(deps.plan, `session-started-${session.id}`, "session.started", userId, {
      sessionId: session.id,
      taskId,
      startedAt: session.startedAt,
    }),
  );
  return { ok: true, session };
}

async function announceEnd(deps: SessionDeps, s: WorkSession): Promise<boolean> {
  if (s.endAnnounced || s.endedAt === null) return false;
  s.endAnnounced = true;
  try {
    await deps.plan.publish(
      envelope(deps.plan, `session-ended-${s.id}`, "session.ended", s.userId, {
        sessionId: s.id,
        taskId: s.taskId,
        endedAt: s.endedAt,
      }),
    );
    return true;
  } catch (err) {
    s.endAnnounced = false;
    throw err;
  }
}

/** The user stops early; the end is the server time, not a client-supplied one. */
export async function stopSession(
  deps: SessionDeps,
  userId: string,
  id: string,
): Promise<{ ok: true; session: WorkSession } | { ok: false; error: "not_found" }> {
  const s = deps.sessions.get(userId, id);
  if (!s) return { ok: false, error: "not_found" };
  if (s.endedAt === null) {
    const nowMs = deps.plan.now().getTime();
    s.endedAt = new Date(Math.min(nowMs, plannedEndMs(s))).toISOString();
  }
  await announceEnd(deps, s);
  return { ok: true, session: s };
}

/**
 * Idempotent job: ends every session whose planned end is at or before `now` and announces
 * `session.ended` once. `now` is a parameter; this code never reads the system clock.
 */
export async function runSessionJob(
  deps: SessionDeps,
  now: Date,
): Promise<{ ended: string[]; failed: string[] }> {
  const result = { ended: [] as string[], failed: [] as string[] };
  for (const s of deps.sessions.all()) {
    if (s.endedAt === null && plannedEndMs(s) <= now.getTime()) {
      s.endedAt = new Date(plannedEndMs(s)).toISOString();
    }
    if (s.endedAt === null || s.endAnnounced) continue;
    try {
      if (await announceEnd(deps, s)) result.ended.push(s.id);
    } catch {
      result.failed.push(s.id);
    }
  }
  return result;
}
