import { ScheduleWeekSchema, TaskSchema, type Task } from "@my-wife/contracts";
import { z } from "zod";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type PlannerWeek = z.infer<typeof ScheduleWeekSchema>;

/** A saved week template as listed by `GET /templates` (no contract schema exists yet). */
export interface PlannerTemplate {
  id: string;
  name: string;
  tasks: unknown[];
}

const TemplateListSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    templates: z.array(z.object({ id: z.string(), name: z.string(), tasks: z.array(z.unknown()) })),
  }),
});
const WeekEnvelopeSchema = z.object({
  ok: z.literal(true),
  data: z.object({ week: ScheduleWeekSchema }),
});
const ChecklistSchema = z.object({
  ok: z.literal(true),
  data: z.object({ tasks: z.array(TaskSchema) }),
});
const PlanSchema = z.object({
  ok: z.literal(true),
  data: z.object({ overloaded: z.boolean(), overloadMinutes: z.number().int().nonnegative() }),
});

export type PlannerResult =
  | { status: "ready"; week: PlannerWeek; templates: PlannerTemplate[]; tasks: Task[] }
  | { status: "empty" }
  | { status: "error" };

export type PlannerAction = { ok: true } | { ok: false; errorKey: string };
export type ApplyResult =
  { ok: true; overloaded: boolean; overloadMinutes: number } | { ok: false; errorKey: string };

/** The seven UTC days of a week, from its first day (schedule days are UTC dates). */
export function weekDays(firstDay: string): string[] {
  const start = new Date(`${firstDay}T00:00:00.000Z`);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
}

/** Tasks per day, with an entry for every day even when it has none. */
export function groupByDay(days: string[], tasks: Task[]): Record<string, Task[]> {
  const out: Record<string, Task[]> = Object.fromEntries(days.map((d) => [d, []]));
  for (const t of tasks) out[t.day]?.push(t);
  return out;
}

/** Splits minutes into "H h M min" parts for the locale templates. */
export function splitMinutes(total: number): { hours: number; minutes: number } {
  return { hours: Math.floor(total / 60), minutes: total % 60 };
}

async function errorCode(res: Response): Promise<string | undefined> {
  try {
    return ((await res.json()) as { error?: { code?: string } }).error?.code;
  } catch {
    return undefined;
  }
}

/** Reads the current week, the saved templates and the tasks of the seven days. */
export async function loadPlanner(doFetch: FetchLike = fetch): Promise<PlannerResult> {
  try {
    const weekRes = await doFetch("/api/weeks/current", { cache: "no-store" });
    if (weekRes.status === 404) return { status: "empty" };
    if (!weekRes.ok) return { status: "error" };
    const week = WeekEnvelopeSchema.safeParse(await weekRes.json());
    if (!week.success) return { status: "error" };

    const tplRes = await doFetch("/api/templates", { cache: "no-store" });
    const tpl = tplRes.ok ? TemplateListSchema.safeParse(await tplRes.json()) : null;
    if (!tpl?.success) return { status: "error" };

    const days = weekDays(week.data.data.week.firstDay);
    const lists = await Promise.all(
      days.map(async (day) => {
        const res = await doFetch(`/api/checklist?date=${encodeURIComponent(day)}`, {
          cache: "no-store",
        });
        const parsed = res.ok ? ChecklistSchema.safeParse(await res.json()) : null;
        return parsed?.success ? parsed.data.data.tasks : null;
      }),
    );
    if (lists.some((l) => l === null)) return { status: "error" };
    return {
      status: "ready",
      week: week.data.data.week,
      templates: tpl.data.data.templates,
      tasks: lists.flat() as Task[],
    };
  } catch {
    return { status: "error" };
  }
}

const APPLY_ERRORS: Record<string, string> = {
  "schedule.template_already_applied": "weekplan.error.already_applied",
  "schedule.template_not_found": "weekplan.error.template_missing",
  "schedule.week_not_draft": "weekplan.error.not_draft",
};

/** Copies a template into the draft week and reports the load of the week. */
export async function applyTemplate(
  weekId: string,
  templateId: string,
  doFetch: FetchLike = fetch,
): Promise<ApplyResult> {
  try {
    const res = await doFetch(`/api/weeks/${encodeURIComponent(weekId)}/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ templateId }),
    });
    if (!res.ok) {
      const code = await errorCode(res);
      return { ok: false, errorKey: (code && APPLY_ERRORS[code]) || "weekplan.error.apply" };
    }
    const parsed = PlanSchema.safeParse(await res.json());
    if (!parsed.success) return { ok: false, errorKey: "weekplan.error.apply" };
    return { ok: true, ...parsed.data.data };
  } catch {
    return { ok: false, errorKey: "weekplan.error.apply" };
  }
}

/** Approves the draft week; routine blocks and tasks are then fixed by the service. */
export async function approveWeek(
  weekId: string,
  doFetch: FetchLike = fetch,
): Promise<PlannerAction> {
  try {
    const res = await doFetch(`/api/weeks/${encodeURIComponent(weekId)}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return res.ok ? { ok: true } : { ok: false, errorKey: "weekplan.error.approve" };
  } catch {
    return { ok: false, errorKey: "weekplan.error.approve" };
  }
}
