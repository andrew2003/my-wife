import { planWeekRoutines } from "./routine-blocks";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "@my-wife/config";
import {
  CompleteTaskRequestSchema,
  CreateTaskRequestSchema,
  IdSchema,
  IsoDateSchema,
  IsoDateTimeSchema,
  parseEvent,
  RecurrencePatternSchema,
  RoutineLevelSchema,
  SETTINGS,
  SpecialModeKindSchema,
  StartTaskRequestSchema,
  SubtaskSchema,
  WeekPlannedItemSchema,
  type EventEnvelope,
} from "@my-wife/contracts";
import { answerCarryOver, runDayEndJob, todayOf } from "./carry-over";
import { LunarRangeError } from "./lunar";
import { lunarOccurrences, materializeWeekRecurrences, type StoredRecurrence } from "./recurrence";
import { resolvePomodoroSettings } from "./pomodoro";
import { createServiceApp, type ServiceDeps } from "@my-wife/service-kit";
import {
  approveWeek,
  checkInOfflineTask,
  completeTask,
  createMemoryPlanStore,
  createWeek,
  runWeekBoundary,
  startTask,
  type PlanDeps,
  type PlanStore,
  type PlanSubtask,
  type PlanTask,
} from "./plan";
import {
  computeWeekLoad,
  copyTemplateIntoWeek,
  type TemplateTask,
  type WeekTemplate,
} from "./week-plan";
import {
  createMemorySessionStore,
  runSessionJob,
  startSession,
  stopSession,
  viewSession,
  type SessionStore,
} from "./sessions";
import { zoneSetting } from "./review";
import {
  buildReview,
  type ReviewOverrunOptions,
  createMemoryLedgerStore,
  recordLedgerEvent,
  runReviewJob,
  type LedgerStore,
} from "./review";
import {
  buildStarterRoutines,
  changeRoutineLevel,
  createMemoryRoutineStore,
  effectiveLevel,
  runRoutineReminderJob,
  type RoutineStore,
} from "./routines";
import { createMemorySleepStore, runSleepJob, type SleepStore } from "./sleep";
import {
  applyPhotoGrade,
  createMemoryWakeStore,
  fakeChallengeGenerator,
  receiveWakePhoto,
  runWakeJob,
  viewWakeToday,
  type MessageRef,
  type WakeDeps,
  type WakeStore,
} from "./wake";
import { buildSampleDay, type SampleAnswers, type SampleBlock } from "./sample-schedule";
import { addDays } from "./week-plan";
import {
  covers,
  endedEvent,
  newPeriodId,
  planPeriod,
  resolveSpecialModeSettings,
  startedEvent,
  type SpecialModePeriod,
} from "./special-mode";

export const SERVICE_NAME = "schedule";

export type ScheduleDeps = ServiceDeps & {
  /** Time is a parameter so tests can simulate it. */
  now?: () => Date;
  /** Reads the user's settings (identity `GET /settings` in production). */
  readSettings?: (userId: string) => Promise<SampleAnswers>;
  /** Announces events on the bus; a no-op without NATS. */
  publish?: (event: EventEnvelope) => void | Promise<void>;
  /** How long a carry-over question stays open; defaults to 24 hours (ADR pending for a setting). */
  carryOverAskExpiryMs?: number;
  /** Overrun thresholds of the weekly review duration suggestion; defaults in `review.ts`. */
  reviewOverrun?: Partial<ReviewOverrunOptions>;
  /** Plan storage port; in memory until the Drizzle store lands. */
  planStore?: PlanStore;
  /** Session storage port; in memory until the Drizzle store lands. */
  sessionStore?: SessionStore;
  /** Fault and overspend ledger copies for the weekly review; in memory for now. */
  ledgerStore?: LedgerStore;
  /** `sleep_night` storage port; in memory until the Drizzle store lands. */
  sleepStore?: SleepStore;
  /** Routine level changes and meal reminders storage port; in memory for now. */
  routineStore?: RoutineStore;
  /** `wake` challenge storage port; in memory until the Drizzle store lands. */
  wakeStore?: WakeStore;
  /** Daily challenge text; the fake generator in M1. */
  generateWakeChallenge?: WakeDeps["generateChallenge"];
  /** notify `sendPhotoRequest` (internal REST in production); a no-op without notify. */
  sendPhotoRequest?: WakeDeps["sendPhotoRequest"];
  /** Plain chat reply through notify; a no-op without notify. */
  sendReply?: (userId: string, message: MessageRef) => Promise<void>;
};

declare module "fastify" {
  interface FastifyInstance {
    /** Ends due sessions and announces `session.ended`; the caller passes `now`. */
    runSessionJob: (now: Date) => Promise<{ ended: string[]; failed: string[] }>;
    /** Advances the `sleep_night` machines and announces bedtime reminders; the caller passes `now`. */
    runSleepJob: (now: Date) => Promise<{ checked: number; failed: string[] }>;
    /** Sends the meal reminders whose window opened; the caller passes `now`. */
    runRoutineJob: (now: Date) => Promise<{ checked: number; failed: string[] }>;
    /** Sends the daily wake challenge once wake time is reached; the caller passes `now`. */
    runWakeJob: (now: Date) => Promise<{ checked: number; failed: string[] }>;
  }
}

/** Request body of `POST /sessions/start`; any client-supplied start time is ignored. */
function parseStartSession(body: unknown) {
  const b = (body ?? {}) as { taskId?: unknown; durationMinutes?: unknown };
  const taskId = IdSchema.safeParse(b.taskId);
  const d = b.durationMinutes;
  const durationOk = d === undefined || (typeof d === "number" && Number.isInteger(d) && d > 0);
  if (!taskId.success || !durationOk) return undefined;
  return { taskId: taskId.data, durationMinutes: d as number | undefined };
}

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
  const ledgers = deps.ledgerStore ?? createMemoryLedgerStore();
  const plan: PlanDeps = {
    store: deps.planStore ?? createMemoryPlanStore(),
    publish: deps.publish ?? (() => undefined),
    now,
    cycleFirstDays: (userId) => ledgers.cycleFirstDays(userId),
  };
  const samples = new Map<string, SampleSchedule>();
  const periods: SpecialModePeriod[] = [];
  /** Faults waived because they fall in a special-mode period: `userId:faultId` -> period id. */
  const specialWaivers = new Map<string, string>();
  const waiveInPeriods = (userId: string) => {
    for (const f of ledgers.faults(userId)) {
      const k = `${userId}:${f.faultId}`;
      if (specialWaivers.has(k)) continue;
      const p = periods.find((x) => x.userId === userId && covers(x, f.occurredAt));
      if (!p) continue;
      specialWaivers.set(k, p.id);
      ledgers.waiveFault(userId, f.faultId);
    }
  };

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
      priority: "normal",
      pendingAsk: null,
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
      if (res.error === "not_in_plan") return fail(reply, 404, "schedule.task_not_in_plan");
      return fail(
        reply,
        409,
        res.error === "subtasks_open"
          ? "schedule.task_subtasks_open"
          : "schedule.task_invalid_state",
      );
    };
  app.post("/tasks/start", transition(startTask, StartTaskRequestSchema));
  app.post("/tasks/complete", transition(completeTask, CompleteTaskRequestSchema));

  app.post("/tasks/carry-over-answer", async (req, reply) => {
    const userId = userOf(req.headers);
    if (!userId) return fail(reply, 401, "schedule.unauthenticated");
    const b = (req.body ?? {}) as { taskId?: unknown; questionId?: unknown; value?: unknown };
    const taskId = IdSchema.safeParse(b.taskId);
    const questionId = IdSchema.safeParse(b.questionId);
    if (!taskId.success || !questionId.success || typeof b.value !== "string")
      return fail(reply, 400, "schedule.invalid_request");
    const res = await answerCarryOver(
      plan,
      userId,
      taskId.data,
      questionId.data,
      b.value,
      readSettings,
    );
    if (res.ok) return { ok: true, data: { task: taskView(res.task) } };
    if (res.error === "not_in_plan") return fail(reply, 404, "schedule.task_not_in_plan");
    if (res.error === "invalid_answer") return fail(reply, 400, "schedule.invalid_request");
    return fail(reply, 409, "schedule.no_open_question");
  });

  /** Internal entry for the scheduler; safe to run any number of times. */
  app.post("/jobs/day-end", async () => ({
    ok: true,
    data: await runDayEndJob(plan, readSettings, { askExpiryMs: deps.carryOverAskExpiryMs }),
  }));

  app.post("/tasks/check-in", async (req, reply) => {
    const userId = userOf(req.headers);
    if (!userId) return fail(reply, 401, "schedule.unauthenticated");
    const b = (req.body ?? {}) as { taskId?: unknown; phase?: unknown };
    const taskId = IdSchema.safeParse(b.taskId);
    const phase = b.phase;
    if (!taskId.success || (phase !== "start" && phase !== "end"))
      return fail(reply, 400, "schedule.invalid_request");
    const res = await checkInOfflineTask(plan, userId, taskId.data, phase);
    if (res.ok) {
      const { userId: _u, ...checkIn } = res.checkIn;
      return {
        ok: true,
        data: {
          task: taskView(res.task),
          checkIn,
          messageKey: `schedule.offline.check_in_${phase}`,
        },
      };
    }
    if (res.error === "not_in_plan") return fail(reply, 404, "schedule.task_not_in_plan");
    if (res.error === "not_offline") return fail(reply, 409, "schedule.task_not_offline");
    return fail(
      reply,
      409,
      res.error === "subtasks_open" ? "schedule.task_subtasks_open" : "schedule.task_invalid_state",
    );
  });

  app.get("/tasks/check-ins", async (req, reply) => {
    const userId = userOf(req.headers);
    if (!userId) return fail(reply, 401, "schedule.unauthenticated");
    const taskId = IdSchema.safeParse((req.query as { taskId?: string }).taskId);
    if (!taskId.success) return fail(reply, 400, "schedule.invalid_request");
    if (!plan.store.getTask(userId, taskId.data))
      return fail(reply, 404, "schedule.task_not_in_plan");
    const checkIns = plan.store.checkInsOf(userId, taskId.data).map(({ userId: _u, ...c }) => c);
    return { ok: true, data: { checkIns } };
  });

  const subtaskView = ({ userId: _userId, ...s }: PlanSubtask) => s;

  app.post("/tasks/subtasks", async (req, reply) => {
    const userId = userOf(req.headers);
    if (!userId) return fail(reply, 401, "schedule.unauthenticated");
    const parsed = SubtaskSchema.pick({ taskId: true, title: true }).safeParse(req.body);
    if (!parsed.success) return fail(reply, 400, "schedule.invalid_request");
    if (!plan.store.getTask(userId, parsed.data.taskId))
      return fail(reply, 404, "schedule.task_not_in_plan");
    const subtask: PlanSubtask = { id: randomUUID(), userId, ...parsed.data, done: false };
    plan.store.addSubtask(subtask);
    return { ok: true, data: { subtask: subtaskView(subtask) } };
  });

  app.get("/tasks/subtasks", async (req, reply) => {
    const userId = userOf(req.headers);
    if (!userId) return fail(reply, 401, "schedule.unauthenticated");
    const taskId = IdSchema.safeParse((req.query as { taskId?: string }).taskId);
    if (!taskId.success) return fail(reply, 400, "schedule.invalid_request");
    if (!plan.store.getTask(userId, taskId.data))
      return fail(reply, 404, "schedule.task_not_in_plan");
    return {
      ok: true,
      data: { subtasks: plan.store.subtasksOf(userId, taskId.data).map(subtaskView) },
    };
  });

  app.post("/subtasks/done", async (req, reply) => {
    const userId = userOf(req.headers);
    if (!userId) return fail(reply, 401, "schedule.unauthenticated");
    const parsed = SubtaskSchema.pick({ done: true })
      .extend({ subtaskId: IdSchema })
      .safeParse(req.body);
    if (!parsed.success) return fail(reply, 400, "schedule.invalid_request");
    const subtask = plan.store.getSubtask(userId, parsed.data.subtaskId);
    if (!subtask) return fail(reply, 404, "schedule.subtask_not_found");
    subtask.done = parsed.data.done;
    return { ok: true, data: { subtask: subtaskView(subtask) } };
  });

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
    const created = createWeek(plan, userId, day.data);
    if ("error" in created) return fail(reply, 409, "schedule.week_not_aligned");
    const { closedAnnounced: _c, reviewAnnounced: _r, userId: _u, ...week } = created;
    return { ok: true, data: { week } };
  });
  app.post("/weeks/:id/approve", async (req, reply) => {
    const userId = userOf(req.headers);
    if (!userId) return fail(reply, 401, "schedule.unauthenticated");
    // Optional planned items travel on `week.planned` for budget (ADR 0013); not interpreted here.
    const items = WeekPlannedItemSchema.array()
      .optional()
      .safeParse((req.body as { plannedItems?: unknown } | null | undefined)?.plannedItems);
    if (!items.success) return fail(reply, 400, "schedule.invalid_request");
    const res = await approveWeek(plan, userId, (req.params as { id: string }).id, items.data);
    if (!res.ok) {
      return res.error === "not_found"
        ? fail(reply, 404, "schedule.week_not_found")
        : fail(reply, 409, "schedule.week_not_draft");
    }
    const { closedAnnounced: _c, reviewAnnounced: _r, userId: _u, ...week } = res.week;
    return { ok: true, data: { week } };
  });
  const templates = new Map<string, WeekTemplate>();
  const templateApplied = new Set<string>();

  app.post("/templates", async (req, reply) => {
    const userId = userOf(req.headers);
    if (!userId) return fail(reply, 401, "schedule.unauthenticated");
    const body = req.body as { name?: unknown; tasks?: unknown } | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name || !Array.isArray(body?.tasks)) return fail(reply, 400, "schedule.invalid_request");
    const tasks: TemplateTask[] = [];
    for (const raw of body.tasks as Record<string, unknown>[]) {
      const { dayOffset, ...rest } = raw ?? {};
      const offset = dayOffset as number;
      const parsed = CreateTaskRequestSchema.omit({ day: true }).safeParse(rest);
      if (!Number.isInteger(offset) || offset < 0 || offset > 6 || !parsed.success) {
        return fail(reply, 400, "schedule.invalid_request");
      }
      const b = parsed.data;
      let minutes: number = SETTINGS["schedule.task_default_minutes"].default;
      if (b.estimatedMinutes === undefined) {
        const answer = (await readSettings(userId))["schedule.task_default_minutes"];
        if (typeof answer === "number" && Number.isInteger(answer) && answer > 0) minutes = answer;
      }
      tasks.push({
        dayOffset: offset,
        title: b.title,
        window: b.window ?? null,
        estimatedMinutes: b.estimatedMinutes ?? minutes,
        energyLevel: b.energyLevel ?? null,
        definitionOfDone: b.definitionOfDone ?? null,
        monitoringProfile: b.monitoringProfile,
        kind: b.kind,
        parentRecurrenceId: b.parentRecurrenceId ?? null,
      });
    }
    const template: WeekTemplate = { id: randomUUID(), userId, name, tasks };
    templates.set(template.id, template);
    const { userId: _u, ...view } = template;
    return { ok: true, data: { template: view } };
  });
  app.get("/templates", async (req, reply) => {
    const userId = userOf(req.headers);
    if (!userId) return fail(reply, 401, "schedule.unauthenticated");
    const list = [...templates.values()]
      .filter((t) => t.userId === userId)
      .map(({ userId: _u, ...view }) => view);
    return { ok: true, data: { templates: list } };
  });

  const recurrences = new Map<string, StoredRecurrence>();
  app.post("/recurrences", async (req, reply) => {
    const userId = userOf(req.headers);
    if (!userId) return fail(reply, 401, "schedule.unauthenticated");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const pattern = RecurrencePatternSchema.safeParse(body.pattern);
    const exceptions = IsoDateSchema.array().safeParse(body.exceptions ?? []);
    const parsedTask = CreateTaskRequestSchema.omit({
      day: true,
      parentRecurrenceId: true,
    }).safeParse(body.task);
    if (
      (body.calendar !== "solar" && body.calendar !== "lunar") ||
      !pattern.success ||
      !exceptions.success ||
      !parsedTask.success
    )
      return fail(reply, 400, "schedule.invalid_request");
    // The lunar pattern belongs to the lunar calendar only, and the other patterns to the solar one.
    if ((body.calendar === "lunar") !== (pattern.data.type === "lunar_day"))
      return fail(reply, 400, "schedule.invalid_request");
    const t = parsedTask.data;
    let minutes: number = SETTINGS["schedule.task_default_minutes"].default;
    if (t.estimatedMinutes === undefined) {
      const answer = (await readSettings(userId))["schedule.task_default_minutes"];
      if (typeof answer === "number" && Number.isInteger(answer) && answer > 0) minutes = answer;
    }
    const base = {
      id: randomUUID(),
      userId,
      exceptions: exceptions.data,
      task: {
        title: t.title,
        window: t.window ?? null,
        estimatedMinutes: t.estimatedMinutes ?? minutes,
        energyLevel: t.energyLevel ?? null,
        definitionOfDone: t.definitionOfDone ?? null,
        monitoringProfile: t.monitoringProfile,
        kind: t.kind,
      },
    };
    const stored: StoredRecurrence =
      pattern.data.type === "lunar_day"
        ? { ...base, calendar: "lunar", pattern: pattern.data }
        : { ...base, calendar: "solar", pattern: pattern.data };
    recurrences.set(stored.id, stored);
    const { userId: _u, ...view } = stored;
    return { ok: true, data: { recurrence: view } };
  });
  app.get("/recurrences", async (req, reply) => {
    const userId = userOf(req.headers);
    if (!userId) return fail(reply, 401, "schedule.unauthenticated");
    const list = [...recurrences.values()]
      .filter((r) => r.userId === userId)
      .map(({ userId: _u, ...view }) => view);
    return { ok: true, data: { recurrences: list } };
  });

  /**
   * Planning step of a draft week: optionally copies a saved template once, then reports the
   * load so "overloaded" is visible before approval. Emits nothing; `week.planned` comes on approve.
   */
  app.post("/weeks/:id/plan", async (req, reply) => {
    const userId = userOf(req.headers);
    if (!userId) return fail(reply, 401, "schedule.unauthenticated");
    const found = plan.store.getWeek(userId, (req.params as { id: string }).id);
    if (!found) return fail(reply, 404, "schedule.week_not_found");
    if (found.state !== "draft") return fail(reply, 409, "schedule.week_not_draft");
    // Compute every recurrence date first, so an unsupported lunar year changes nothing.
    try {
      for (const r of recurrences.values())
        if (r.userId === userId && r.calendar === "lunar")
          lunarOccurrences(r, found.firstDay, addDays(found.firstDay, 6));
    } catch (error) {
      if (error instanceof LunarRangeError) return fail(reply, 422, error.code);
      throw error;
    }
    const templateId = (req.body as { templateId?: unknown } | null)?.templateId;
    if (templateId !== undefined) {
      const template = typeof templateId === "string" ? templates.get(templateId) : undefined;
      if (!template || template.userId !== userId)
        return fail(reply, 404, "schedule.template_not_found");
      // Claim before copying so a concurrent call cannot duplicate the tasks.
      if (templateApplied.has(found.id))
        return fail(reply, 409, "schedule.template_already_applied");
      templateApplied.add(found.id);
      copyTemplateIntoWeek(plan.store, found, template, randomUUID);
    }
    const values = await readSettings(userId);
    const recurringTasks = materializeWeekRecurrences(
      plan.store,
      [...recurrences.values()],
      userId,
      found.firstDay,
      todayOf(now(), zoneSetting(values["calendar.time_zone"])),
      randomUUID,
    ).map(taskView);
    const load = computeWeekLoad(plan.store, found, values);
    const routines = planWeekRoutines(plan.store, found, values);
    const { closedAnnounced: _c, reviewAnnounced: _r, userId: _u, ...week } = found;
    return {
      ok: true,
      data: {
        week,
        recurringTasks,
        overloaded: load.overloaded || routines.routineOverloaded,
        overloadMinutes: load.overloadMinutes,
        routineOverloaded: routines.routineOverloaded,
        routineOverloadMinutes: routines.routineOverloadMinutes,
        routineBlocks: routines.blocks,
        plannedMinutes: load.plannedMinutes,
        availableMinutes: load.availableMinutes,
      },
    };
  });

  app.get("/weeks/current", async (req, reply) => {
    const userId = userOf(req.headers);
    if (!userId) return fail(reply, 401, "schedule.unauthenticated");
    const found = plan.store.latestWeek(userId);
    if (!found) return fail(reply, 404, "schedule.week_not_found");
    const { closedAnnounced: _c, reviewAnnounced: _r, userId: _u, ...week } = found;
    return { ok: true, data: { week } };
  });

  const sessionDeps = { plan, sessions: deps.sessionStore ?? createMemorySessionStore() };

  /** The start time is always the server time; the body only carries the task and length. */
  app.post("/sessions/start", async (req, reply) => {
    const userId = userOf(req.headers);
    if (!userId) return fail(reply, 401, "schedule.unauthenticated");
    const parsed = parseStartSession(req.body);
    if (!parsed) return fail(reply, 400, "schedule.invalid_request");
    const pomodoro = resolvePomodoroSettings(await readSettings(userId));
    const minutes = parsed.durationMinutes ?? pomodoro.workMinutes;
    const res = await startSession(sessionDeps, userId, parsed.taskId, minutes, pomodoro);
    if (res.ok) return { ok: true, data: { session: viewSession(res.session, now()) } };
    if (res.error === "not_in_plan") return fail(reply, 404, "schedule.task_not_in_plan");
    return fail(reply, 409, `schedule.session_${res.error}`);
  });
  /** Reload path: the running session of a task, so the countdown resumes from the stored end. */
  app.get("/sessions/active", async (req, reply) => {
    const userId = userOf(req.headers);
    if (!userId) return fail(reply, 401, "schedule.unauthenticated");
    const taskId = (req.query as { taskId?: string }).taskId;
    const s = taskId ? sessionDeps.sessions.activeForTask(userId, taskId) : undefined;
    if (!s) return fail(reply, 404, "schedule.session_not_found");
    return { ok: true, data: { session: viewSession(s, now()) } };
  });
  app.get("/sessions/:id", async (req, reply) => {
    const userId = userOf(req.headers);
    if (!userId) return fail(reply, 401, "schedule.unauthenticated");
    const s = sessionDeps.sessions.get(userId, (req.params as { id: string }).id);
    if (!s) return fail(reply, 404, "schedule.session_not_found");
    return { ok: true, data: { session: viewSession(s, now()) } };
  });
  app.post("/sessions/:id/stop", async (req, reply) => {
    const userId = userOf(req.headers);
    if (!userId) return fail(reply, 401, "schedule.unauthenticated");
    const res = await stopSession(sessionDeps, userId, (req.params as { id: string }).id);
    if (!res.ok) return fail(reply, 404, "schedule.session_not_found");
    return { ok: true, data: { session: viewSession(res.session, now()) } };
  });

  /** Entry for the scheduler and the dev-runner clock; `now` is a parameter. */
  app.decorate("runSessionJob", (at: Date) => runSessionJob(sessionDeps, at));
  const sleepDeps = {
    plan,
    store: deps.sleepStore ?? createMemorySleepStore(),
    readSettings: readSettings as (userId: string) => Promise<Record<string, unknown>>,
  };
  app.decorate("runSleepJob", (at: Date) => runSleepJob(sleepDeps, at));
  app.post("/jobs/sleep", async () => ({
    ok: true,
    data: await runSleepJob(sleepDeps, now()),
  }));
  app.get("/sleep/night", async (req, reply) => {
    const userId = userOf(req.headers);
    if (!userId) return fail(reply, 401, "schedule.unauthenticated");
    const date = IsoDateSchema.safeParse((req.query as { date?: string }).date);
    if (!date.success) return fail(reply, 400, "schedule.invalid_request");
    const night = sleepDeps.store.get(userId, date.data);
    if (!night) return fail(reply, 404, "schedule.night_not_found");
    const { userId: _u, ...view } = night;
    return { ok: true, data: { night: view } };
  });
  const routineStore = deps.routineStore ?? createMemoryRoutineStore();
  const routineDeps = {
    plan,
    store: routineStore,
    readSettings: readSettings as (userId: string) => Promise<Record<string, unknown>>,
  };
  app.decorate("runRoutineJob", (at: Date) => runRoutineReminderJob(routineDeps, at));
  app.post("/jobs/routines", async () => ({
    ok: true,
    data: await runRoutineReminderJob(routineDeps, now()),
  }));
  /** Routines with the level in force at `at` (default now). */
  app.get("/routines", async (req, reply) => {
    const userId = userOf(req.headers);
    if (!userId) return fail(reply, 401, "schedule.unauthenticated");
    const atRaw = (req.query as { at?: string }).at;
    const at = atRaw ? new Date(atRaw) : now();
    if (Number.isNaN(at.getTime())) return fail(reply, 400, "schedule.invalid_request");
    const raw = await routineDeps.readSettings(userId);
    const routines = buildStarterRoutines(raw).map((r) => ({
      ...r,
      level: effectiveLevel(routineDeps.store, userId, r, at),
    }));
    return { ok: true, data: { routines } };
  });
  /** Called after the user saved a level; lowering from `commit` waits for next week. */
  app.post("/routines/level-changes", async (req, reply) => {
    const userId = userOf(req.headers);
    if (!userId) return fail(reply, 401, "schedule.unauthenticated");
    const b = (req.body ?? {}) as { routineId?: unknown; from?: unknown; to?: unknown };
    const from = RoutineLevelSchema.safeParse(b.from);
    const to = RoutineLevelSchema.safeParse(b.to);
    if (
      typeof b.routineId !== "string" ||
      !/^[a-z][a-z0-9_]{0,39}$/.test(b.routineId) ||
      !from.success ||
      !to.success
    ) {
      return fail(reply, 400, "schedule.invalid_request");
    }
    try {
      const change = await changeRoutineLevel(
        routineDeps,
        userId,
        { routineId: b.routineId, from: from.data, to: to.data },
        now(),
      );
      return { ok: true, data: { change } };
    } catch {
      return fail(reply, 503, "schedule.publish_failed");
    }
  });
  const wakeDeps: WakeDeps = {
    plan,
    store: deps.wakeStore ?? createMemoryWakeStore(),
    readSettings: readSettings as WakeDeps["readSettings"],
    generateChallenge: deps.generateWakeChallenge ?? fakeChallengeGenerator,
    sendPhotoRequest: deps.sendPhotoRequest ?? (async () => undefined),
    sendReply: deps.sendReply ?? (async () => undefined),
    levelOf: (userId, raw, at) => {
      const wake = buildStarterRoutines(raw).find((r) => r.id === "wake");
      return wake ? effectiveLevel(routineStore, userId, wake, at) : "off";
    },
  };
  app.decorate("runWakeJob", (at: Date) => runWakeJob(wakeDeps, at));
  app.post("/jobs/wake", async () => ({ ok: true, data: await runWakeJob(wakeDeps, now()) }));
  /** Today's recorded wake for the web card (MW-163). */
  app.get("/wake/today", async (req, reply) => {
    const userId = userOf(req.headers);
    if (!userId) return fail(reply, 401, "schedule.unauthenticated");
    return { ok: true, data: { wake: await viewWakeToday(wakeDeps, userId, now()) } };
  });
  /** notify reports a photo (metadata only, never the image) before handing it to ai. */
  app.post("/wake/photos", async (req, reply) => {
    const userId = userOf(req.headers);
    if (!userId) return fail(reply, 401, "schedule.unauthenticated");
    const b = (req.body ?? {}) as { challengeId?: unknown; sentAt?: unknown };
    const id = IdSchema.safeParse(b.challengeId);
    const sentAt = IsoDateTimeSchema.safeParse(b.sentAt);
    if (!id.success || !sentAt.success) return fail(reply, 400, "schedule.invalid_request");
    const res = await receiveWakePhoto(wakeDeps, userId, id.data, new Date(sentAt.data));
    if (res.ok)
      return { ok: true, data: { accepted: res.accepted, challengeKey: res.challengeKey } };
    return res.error === "not_found"
      ? fail(reply, 404, "schedule.challenge_not_found")
      : fail(reply, 409, "schedule.challenge_graded");
  });
  /** Internal entry for the bus bridge: `ai.photo_graded`. */
  app.post("/events/photo-graded", async (req, reply) => {
    const parsed = parseEvent(req.body);
    if (!parsed.success || parsed.data.type !== "ai.photo_graded") {
      return fail(reply, 400, "schedule.invalid_event");
    }
    const { payload } = parsed.data as EventEnvelope<"ai.photo_graded">;
    return {
      ok: true,
      data: { result: await applyPhotoGrade(wakeDeps, payload.challengeId, payload.grade) },
    };
  });
  app.post("/jobs/session-end", async () => ({
    ok: true,
    data: await runSessionJob(sessionDeps, now()),
  }));

  /** Internal entry for the scheduler (BullMQ in production); safe to run any number of times. */
  app.post("/jobs/week-boundary", async () => {
    // week.closed first; the review only follows weeks whose week.closed was announced.
    const boundary = await runWeekBoundary(plan);
    const review = await runReviewJob(plan, readSettings);
    return { ok: true, data: { ...boundary, reviewed: review.ready, reviewFailed: review.failed } };
  });

  /** Internal entry for the bus bridge: `fault.recorded`, `fault.waived`, `overspend.detected`. */
  app.post("/events/ledger", async (req, reply) => {
    const parsed = parseEvent(req.body);
    if (!parsed.success) return fail(reply, 400, "schedule.invalid_event");
    const recorded = recordLedgerEvent(ledgers, parsed.data);
    // A fault that arrives after its period was activated is waived on arrival.
    if (parsed.data.type === "fault.recorded") waiveInPeriods(parsed.data.userId);
    return { ok: true, data: { recorded } };
  });

  const periodView = ({ userId, endedAnnounced: _e, ...p }: SpecialModePeriod) => ({
    ...p,
    waivedFaults: [...specialWaivers]
      .filter(([k, id]) => id === p.id && k.startsWith(`${userId}:`))
      .map(([k]) => ({ faultId: k.slice(userId.length + 1), reason: "special_mode" as const })),
  });

  /** Activates sick, travel or holiday mode for whole local days (spec 20 section 6). */
  app.post("/special-modes", async (req, reply) => {
    const userId = userOf(req.headers);
    if (!userId) return fail(reply, 401, "schedule.unauthenticated");
    const b = (req.body ?? {}) as Record<string, unknown>;
    const kind = SpecialModeKindSchema.safeParse(b.kind);
    const fromDay = IsoDateSchema.safeParse(b.fromDay);
    const toDay = IsoDateSchema.safeParse(b.toDay);
    const reasonOk =
      b.reason === undefined || (typeof b.reason === "string" && b.reason.length <= 500);
    if (!kind.success || !fromDay.success || !toDay.success || !reasonOk) {
      return fail(reply, 400, "schedule.invalid_request");
    }
    const parsed = {
      data: {
        kind: kind.data,
        fromDay: fromDay.data,
        toDay: toDay.data,
        reason: b.reason as string | undefined,
      },
    };
    const settings = resolveSpecialModeSettings(await readSettings(userId));
    const planned = planPeriod({
      ...parsed.data,
      now: now(),
      settings,
      cycleFirstDays: ledgers.cycleFirstDays(userId),
      existing: periods.filter((p) => p.userId === userId),
    });
    if (!planned.ok)
      return fail(reply, planned.code.endsWith("invalid_range") ? 400 : 409, planned.code);
    const period: SpecialModePeriod = {
      ...planned.period,
      id: newPeriodId(),
      userId,
      endedAnnounced: false,
    };
    await (deps.publish ?? (() => undefined))(startedEvent(period));
    periods.push(period);
    waiveInPeriods(userId);
    reply.code(201);
    return { ok: true, data: { period: periodView(period) } };
  });

  app.get("/special-modes", async (req, reply) => {
    const userId = userOf(req.headers);
    if (!userId) return fail(reply, 401, "schedule.unauthenticated");
    return {
      ok: true,
      data: { periods: periods.filter((p) => p.userId === userId).map(periodView) },
    };
  });

  /** Internal job: announces `special_mode.ended` once for every period whose window passed. */
  app.post("/jobs/special-modes", async () => {
    const ended: string[] = [];
    const failed: string[] = [];
    for (const p of periods) {
      if (p.endedAnnounced || Date.parse(p.to) > now().getTime()) continue;
      p.endedAnnounced = true;
      try {
        await (deps.publish ?? (() => undefined))(endedEvent(p, now()));
        ended.push(p.id);
      } catch {
        p.endedAnnounced = false;
        failed.push(p.id);
      }
    }
    return { ok: true, data: { ended, failed } };
  });

  app.get("/weeks/:id/review", async (req, reply) => {
    const userId = userOf(req.headers);
    if (!userId) return fail(reply, 401, "schedule.unauthenticated");
    const week = plan.store.getWeek(userId, (req.params as { id: string }).id);
    if (!week) return fail(reply, 404, "schedule.week_not_found");
    if (!week.closedAnnounced) return fail(reply, 409, "schedule.review_not_ready");
    return {
      ok: true,
      data: {
        review: buildReview(plan.store, ledgers, week, sessionDeps.sessions, deps.reviewOverrun),
      },
    };
  });
  return app;
}
