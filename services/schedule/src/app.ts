import { randomUUID } from "node:crypto";
import type { AppConfig } from "@my-wife/config";
import {
  CompleteTaskRequestSchema,
  CreateTaskRequestSchema,
  IsoDateSchema,
  parseEvent,
  SETTINGS,
  StartTaskRequestSchema,
  type EventEnvelope,
} from "@my-wife/contracts";
import { createServiceApp, type ServiceDeps } from "@my-wife/service-kit";
import {
  approveWeek,
  completeTask,
  createMemoryPlanStore,
  createWeek,
  runWeekBoundary,
  startTask,
  type PlanDeps,
  type PlanStore,
  type PlanTask,
} from "./plan";
import { buildSampleDay, type SampleAnswers, type SampleBlock } from "./sample-schedule";

export const SERVICE_NAME = "schedule";

export type ScheduleDeps = ServiceDeps & {
  /** Time is a parameter so tests can simulate it. */
  now?: () => Date;
  /** Reads the user's settings (identity `GET /settings` in production). */
  readSettings?: (userId: string) => Promise<SampleAnswers>;
  /** Announces events on the bus; a no-op without NATS. */
  publish?: (event: EventEnvelope) => void | Promise<void>;
  /** Plan storage port; in memory until the Drizzle store lands. */
  planStore?: PlanStore;
};

interface SampleSchedule {
  generatedAt: string;
  blocks: SampleBlock[];
}

/** Without a settings source every answer falls back to its registry default. */
const defaultReader = async (): Promise<SampleAnswers> => ({});

/** Factory used by main.ts, the dev runner and tests; no process-level globals (ADR 0007). */
export function createApp(config: AppConfig, deps: ScheduleDeps = {}) {
  const app = createServiceApp({
    name: SERVICE_NAME,
    logLevel: config.logLevel,
    nats: deps.nats,
  });
  const now = deps.now ?? (() => new Date());
  const readSettings = deps.readSettings ?? defaultReader;
  const plan: PlanDeps = {
    store: deps.planStore ?? createMemoryPlanStore(),
    publish: deps.publish ?? (() => undefined),
    now,
  };
  const samples = new Map<string, SampleSchedule>();

  /** Internal entry for the bus bridge: `onboarding.step_completed` with step `qa_templates`. */
  app.post("/events/onboarding-step-completed", async (req, reply) => {
    const parsed = parseEvent(req.body);
    if (!parsed.success || parsed.data.type !== "onboarding.step_completed") {
      return reply.code(400).send({ ok: false, error: { code: "schedule.invalid_event" } });
    }
    const { userId, payload } = parsed.data as EventEnvelope<"onboarding.step_completed">;
    if (payload.step !== "qa_templates" || samples.has(userId)) {
      return { ok: true, data: { generated: false } };
    }
    // Reserve first so a concurrent delivery cannot generate twice.
    const sample: SampleSchedule = { generatedAt: now().toISOString(), blocks: [] };
    samples.set(userId, sample);
    try {
      sample.blocks = buildSampleDay(await readSettings(userId));
    } catch (err) {
      samples.delete(userId);
      throw err;
    }
    return { ok: true, data: { generated: true } };
  });

  app.get("/sample-schedule", async (req, reply) => {
    const id = req.headers["x-user-id"];
    if (typeof id !== "string" || !id) {
      return reply.code(401).send({ ok: false, error: { code: "schedule.unauthenticated" } });
    }
    const sample = samples.get(id);
    if (!sample) return reply.code(404).send({ ok: false, error: { code: "schedule.not_found" } });
    return { ok: true, data: sample };
  });

  const fail = (reply: { code(n: number): unknown }, status: number, code: string) => {
    reply.code(status);
    return { ok: false, error: { code } };
  };
  const userOf = (headers: Record<string, unknown>) => {
    const id = headers["x-user-id"];
    return typeof id === "string" && id ? id : undefined;
  };
  const taskView = ({ userId: _userId, ...task }: PlanTask) => task;

  app.post("/tasks", async (req, reply) => {
    const userId = userOf(req.headers);
    if (!userId) return fail(reply, 401, "schedule.unauthenticated");
    const parsed = CreateTaskRequestSchema.safeParse(req.body);
    if (!parsed.success) return fail(reply, 400, "schedule.invalid_request");
    const b = parsed.data;
    let defaultMinutes: number = SETTINGS["schedule.task_default_minutes"].default;
    if (b.estimatedMinutes === undefined) {
      const answer = (await readSettings(userId))["schedule.task_default_minutes"];
      if (typeof answer === "number" && Number.isInteger(answer) && answer > 0)
        defaultMinutes = answer;
    }
    const task: PlanTask = {
      id: randomUUID(),
      userId,
      title: b.title,
      day: b.day,
      window: b.window ?? null,
      estimatedMinutes: b.estimatedMinutes ?? defaultMinutes,
      energyLevel: b.energyLevel ?? null,
      definitionOfDone: b.definitionOfDone ?? null,
      monitoringProfile: b.monitoringProfile,
      kind: b.kind,
      state: "planned",
      carriedCount: 0,
      parentRecurrenceId: b.parentRecurrenceId ?? null,
    };
    plan.store.addTask(task);
    return { ok: true, data: { task: taskView(task) } };
  });

  const transition =
    (
      run: typeof startTask,
      schema: typeof StartTaskRequestSchema | typeof CompleteTaskRequestSchema,
    ) =>
    async (
      req: { headers: Record<string, unknown>; body: unknown },
      reply: { code(n: number): unknown },
    ) => {
      const userId = userOf(req.headers);
      if (!userId) return fail(reply, 401, "schedule.unauthenticated");
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return fail(reply, 400, "schedule.invalid_request");
      const res = await run(plan, userId, parsed.data.taskId);
      if (res.ok) return { ok: true, data: { task: taskView(res.task) } };
      return res.error === "not_in_plan"
        ? fail(reply, 404, "schedule.task_not_in_plan")
        : fail(reply, 409, "schedule.task_invalid_state");
    };
  app.post("/tasks/start", transition(startTask, StartTaskRequestSchema));
  app.post("/tasks/complete", transition(completeTask, CompleteTaskRequestSchema));

  /** Daily checklist: the tasks of one day, in plan order. */
  app.get("/checklist", async (req, reply) => {
    const userId = userOf(req.headers);
    if (!userId) return fail(reply, 401, "schedule.unauthenticated");
    const date = IsoDateSchema.safeParse((req.query as { date?: string }).date);
    if (!date.success) return fail(reply, 400, "schedule.invalid_request");
    return {
      ok: true,
      data: { date: date.data, tasks: plan.store.tasksOn(userId, date.data).map(taskView) },
    };
  });

  app.post("/weeks", async (req, reply) => {
    const userId = userOf(req.headers);
    if (!userId) return fail(reply, 401, "schedule.unauthenticated");
    const day = IsoDateSchema.safeParse((req.body as { firstDay?: string } | null)?.firstDay);
    if (!day.success) return fail(reply, 400, "schedule.invalid_request");
    const { closedAnnounced: _c, userId: _u, ...week } = createWeek(plan, userId, day.data);
    return { ok: true, data: { week } };
  });
  app.post("/weeks/:id/approve", async (req, reply) => {
    const userId = userOf(req.headers);
    if (!userId) return fail(reply, 401, "schedule.unauthenticated");
    const res = await approveWeek(plan, userId, (req.params as { id: string }).id);
    if (!res.ok) {
      return res.error === "not_found"
        ? fail(reply, 404, "schedule.week_not_found")
        : fail(reply, 409, "schedule.week_not_draft");
    }
    const { closedAnnounced: _c, userId: _u, ...week } = res.week;
    return { ok: true, data: { week } };
  });
  app.get("/weeks/current", async (req, reply) => {
    const userId = userOf(req.headers);
    if (!userId) return fail(reply, 401, "schedule.unauthenticated");
    const found = plan.store.latestWeek(userId);
    if (!found) return fail(reply, 404, "schedule.week_not_found");
    const { closedAnnounced: _c, userId: _u, ...week } = found;
    return { ok: true, data: { week } };
  });

  /** Internal entry for the scheduler (BullMQ in production); safe to run any number of times. */
  app.post("/jobs/week-boundary", async () => ({ ok: true, data: await runWeekBoundary(plan) }));
  return app;
}
