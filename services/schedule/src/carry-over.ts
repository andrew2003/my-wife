import { CarryOverRuleSchema, SETTINGS } from "@my-wife/contracts";
import { addDays } from "./week-plan";
import { envelope, type PlanDeps, type PlanTask, type TaskPriority } from "./plan";

type CarryOverRule = "roll_forward" | "lower_priority" | "ask";
export const CARRY_OVER_ANSWERS = ["roll_forward", "lower_priority", "skip"] as const;
export type CarryOverAnswer = (typeof CARRY_OVER_ANSWERS)[number];

/** An unanswered question falls back to `roll_forward` after this long (decisions.md, M3 audit). */
const ASK_EXPIRY_MS = 86_400_000;

const DEMOTE: Record<TaskPriority, TaskPriority> = { high: "normal", normal: "low", low: "low" };

export interface CarryOverSettings {
  rule: CarryOverRule;
  maxTimes: number;
}

/** Reads the two carry-over settings; invalid or missing values fall back to registry defaults. */
export function resolveCarryOverSettings(values: Record<string, unknown>): CarryOverSettings {
  const rule = CarryOverRuleSchema.safeParse(values["schedule.carry_over_rule"]);
  const max = values["schedule.carry_over_max_times"];
  return {
    rule: rule.success ? rule.data : SETTINGS["schedule.carry_over_rule"].default,
    maxTimes:
      typeof max === "number" && Number.isInteger(max) && max > 0
        ? max
        : SETTINGS["schedule.carry_over_max_times"].default,
  };
}

const todayOf = (now: Date) => now.toISOString().slice(0, 10);

/** The day a carried task lands on: the day after its own, or today when the job ran late. */
const targetDay = (task: PlanTask, now: Date) => {
  const next = addDays(task.day, 1);
  const today = todayOf(now);
  return today > next ? today : next;
};

/** Moves the task to its next day and announces it; rolls everything back if the publish fails. */
async function carry(deps: PlanDeps, task: PlanTask, demote: boolean) {
  const before = {
    day: task.day,
    state: task.state,
    count: task.carriedCount,
    prio: task.priority,
  };
  const toDay = targetDay(task, deps.now());
  task.day = toDay;
  task.state = "planned";
  task.carriedCount += 1;
  task.pendingAsk = null;
  if (demote) task.priority = DEMOTE[task.priority];
  try {
    await deps.publish(
      envelope(deps, `task-carried-${task.id}-${task.carriedCount}`, "task.carried", task.userId, {
        taskId: task.id,
        carriedCount: task.carriedCount,
        toDay,
      }),
    );
  } catch (err) {
    task.day = before.day;
    task.state = before.state;
    task.carriedCount = before.count;
    task.priority = before.prio;
    throw err;
  }
}

async function ask(deps: PlanDeps, task: PlanTask, settings: CarryOverSettings) {
  const questionId = `carry-${task.id}-${task.carriedCount}`;
  const expiresAt = new Date(deps.now().getTime() + ASK_EXPIRY_MS).toISOString();
  task.pendingAsk = { questionId, expiresAt };
  try {
    await deps.publish(
      envelope(
        deps,
        `ask-carry-over-${task.id}-${task.carriedCount}`,
        "ask.carry_over",
        task.userId,
        {
          questionId,
          kind: "carry_over",
          subjectRef: `task:${task.id}`,
          options: CARRY_OVER_ANSWERS.map((value) => ({
            value,
            labelKey: `schedule.carry_over.option.${value}`,
          })),
          expiresAt,
          params: {
            title: task.title,
            carriedCount: task.carriedCount,
            maxTimes: settings.maxTimes,
          },
        },
      ),
    );
  } catch (err) {
    task.pendingAsk = null;
    throw err;
  }
}

/**
 * Day-end job. Every task of a past day still `planned` or `in_progress` is handled by the
 * carry-over rule; once `carry_over_max_times` is reached the bot asks regardless of the rule.
 * A task with an open question is left alone until it expires, then it rolls forward.
 * Idempotent: a carried task sits on a later day, an asked task holds its open question.
 */
export async function runDayEndJob(
  deps: PlanDeps,
  readSettings: (userId: string) => Promise<Record<string, unknown>>,
): Promise<{ carried: string[]; asked: string[]; failed: string[] }> {
  const now = deps.now();
  const today = todayOf(now);
  const result = { carried: [] as string[], asked: [] as string[], failed: [] as string[] };
  const cache = new Map<string, CarryOverSettings>();
  for (const task of deps.store.allTasks()) {
    if (task.day >= today) continue;
    if (task.state !== "planned" && task.state !== "in_progress") continue;
    try {
      if (task.pendingAsk) {
        if (Date.parse(task.pendingAsk.expiresAt) > now.getTime()) continue;
        await carry(deps, task, false);
        result.carried.push(task.id);
        continue;
      }
      let settings = cache.get(task.userId);
      if (!settings) {
        settings = resolveCarryOverSettings(await readSettings(task.userId));
        cache.set(task.userId, settings);
      }
      // The server stops a task still running at day end; it returns to `planned`.
      if (task.state === "in_progress") task.state = "planned";
      if (settings.rule === "ask" || task.carriedCount >= settings.maxTimes) {
        await ask(deps, task, settings);
        result.asked.push(task.id);
      } else {
        await carry(deps, task, settings.rule === "lower_priority");
        result.carried.push(task.id);
      }
    } catch {
      result.failed.push(task.id);
    }
  }
  return result;
}

export type AnswerResult =
  | { ok: true; task: PlanTask }
  | { ok: false; error: "not_in_plan" | "no_open_question" | "invalid_answer" };

/** The user answers `ask.carry_over`. A stale or repeated answer is refused. */
export async function answerCarryOver(
  deps: PlanDeps,
  userId: string,
  taskId: string,
  questionId: string,
  value: string,
): Promise<AnswerResult> {
  const task = deps.store.getTask(userId, taskId);
  if (!task) return { ok: false, error: "not_in_plan" };
  if (!CARRY_OVER_ANSWERS.includes(value as CarryOverAnswer))
    return { ok: false, error: "invalid_answer" };
  if (!task.pendingAsk || task.pendingAsk.questionId !== questionId)
    return { ok: false, error: "no_open_question" };
  const pending = task.pendingAsk;
  if (value === "skip") {
    task.state = "skipped";
    task.pendingAsk = null;
    return { ok: true, task };
  }
  try {
    await carry(deps, task, value === "lower_priority");
  } catch (err) {
    task.pendingAsk = pending;
    throw err;
  }
  return { ok: true, task };
}
