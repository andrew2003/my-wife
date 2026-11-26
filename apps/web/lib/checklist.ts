import type { Task } from "@my-wife/contracts";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type TaskAction = "start" | "done";

export type ChecklistResult =
  { ok: true; tasks: Task[] } | { ok: false; tasks: Task[]; code?: string };

const ACTION_PATH: Record<TaskAction, string> = {
  start: "/api/tasks/start",
  done: "/api/tasks/complete",
};

/** Schedule days are UTC dates (decisions: MW-030). */
export function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

async function readJson(
  res: Response,
): Promise<{ ok?: boolean; data?: unknown; error?: { code?: string } }> {
  try {
    return (await res.json()) as never;
  } catch {
    return {};
  }
}

/** Reads the checklist of one day through the gateway (same-origin `/api`). */
export async function loadChecklist(
  date: string,
  doFetch: FetchLike = fetch,
): Promise<ChecklistResult> {
  try {
    const res = await doFetch(`/api/checklist?date=${encodeURIComponent(date)}`, {
      cache: "no-store",
    });
    const body = await readJson(res);
    const tasks = (body.data as { tasks?: Task[] } | undefined)?.tasks;
    if (!res.ok || !body.ok || !Array.isArray(tasks)) return { ok: false, tasks: [] };
    return { ok: true, tasks };
  } catch {
    return { ok: false, tasks: [] };
  }
}

/**
 * Sends start or done for one task and returns the list with the saved task in place.
 * On failure the list is returned unchanged with the error code.
 */
export async function applyTaskAction(
  action: TaskAction,
  taskId: string,
  tasks: Task[],
  doFetch: FetchLike = fetch,
): Promise<ChecklistResult> {
  try {
    const res = await doFetch(ACTION_PATH[action], {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId }),
    });
    const body = await readJson(res);
    const saved = (body.data as { task?: Task } | undefined)?.task;
    if (!res.ok || !body.ok || !saved) return { ok: false, tasks, code: body.error?.code };
    return { ok: true, tasks: tasks.map((t) => (t.id === saved.id ? saved : t)) };
  } catch {
    return { ok: false, tasks };
  }
}
