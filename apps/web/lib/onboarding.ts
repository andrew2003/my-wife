type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type AnswerSetting = "routine.wake.time" | "routine.sleep.start" | "budget.cycle_weeks";
export type AnswerValue = string | number;

export interface Question {
  setting: AnswerSetting;
  /** Locale key of the question label. */
  labelKey: string;
  input: "time" | "number";
}

/** Setup questions that map to a user setting (identity allowlist). Every one is skippable. */
export const QUESTIONS: readonly Question[] = [
  { setting: "routine.wake.time", labelKey: "onboarding.q.wake", input: "time" },
  { setting: "routine.sleep.start", labelKey: "onboarding.q.sleep", input: "time" },
  { setting: "budget.cycle_weeks", labelKey: "onboarding.q.cycle_weeks", input: "number" },
];

export type FormValues = Partial<Record<AnswerSetting, string>>;
export type Answers = Partial<Record<AnswerSetting, AnswerValue>>;

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Keeps the filled answers; an unfilled question is left to the standard template. */
export function buildAnswers(
  values: FormValues,
): { ok: true; answers: Answers } | { ok: false; errorKey: string } {
  const answers: Answers = {};
  for (const q of QUESTIONS) {
    const raw = values[q.setting]?.trim();
    if (!raw) continue;
    if (q.input === "time") {
      if (!TIME.test(raw)) return { ok: false, errorKey: "onboarding.error.invalid" };
      answers[q.setting] = raw;
    } else {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) return { ok: false, errorKey: "onboarding.error.invalid" };
      answers[q.setting] = n;
    }
  }
  return { ok: true, answers };
}

/** One block of the generated day; the title is a locale key (schedule service). */
export interface ScheduleBlockView {
  titleKey: string;
  start: string;
  end: string;
  type: "routine" | "daily_rhythm" | "work";
  editable: boolean;
}

export interface BudgetPreview {
  cycle: { weeks: number; firstDay: string };
  categories: { id: string; name: string; shortCode: string; cycleLimitVnd: number }[];
}

export interface Previews {
  schedule: ScheduleBlockView[];
  budget: BudgetPreview;
}

export type FinishResult = { ok: true; previews: Previews } | { ok: false; errorKey: string };

export interface FinishDeps {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** How many times the previews are read while the services generate them. */
  attempts?: number;
  delayMs?: number;
}

const DEFAULT_ATTEMPTS = 8;
const DEFAULT_DELAY_MS = 1000;

async function readData<T>(res: Response): Promise<T | null> {
  try {
    const body = (await res.json()) as { ok?: boolean; data?: T };
    return res.ok && body.ok ? (body.data ?? null) : null;
  } catch {
    return null;
  }
}

async function post(doFetch: FetchLike, url: string, body: unknown): Promise<boolean> {
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function get<T>(doFetch: FetchLike, url: string): Promise<T | null> {
  try {
    return await readData<T>(await doFetch(url, { cache: "no-store" }));
  } catch {
    return null;
  }
}

/** Reads the generated schedule and budget; both are produced from the step event. */
export async function loadPreviews(deps: FinishDeps = {}): Promise<Previews | null> {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts = deps.attempts ?? DEFAULT_ATTEMPTS;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(deps.delayMs ?? DEFAULT_DELAY_MS);
    const [schedule, budget] = await Promise.all([
      get<{ blocks: ScheduleBlockView[] }>(doFetch, "/api/sample-schedule"),
      get<BudgetPreview>(doFetch, "/api/budget/sample-cycle"),
    ]);
    if (schedule && budget) return { schedule: schedule.blocks, budget };
  }
  return null;
}

/**
 * Ends the questions step. Answers are saved first (never on Skip); the step is then completed,
 * which makes identity emit the event that generates the schedule and budget; finally the
 * generated previews are read. With Skip, or no answers, the services produce the standard templates.
 */
export async function finishQuestions(
  answers: Answers,
  skipped: boolean,
  deps: FinishDeps = {},
): Promise<FinishResult> {
  const doFetch = deps.fetch ?? fetch;
  if (!skipped && Object.keys(answers).length > 0) {
    if (!(await post(doFetch, "/api/onboarding/setup-answers", { answers }))) {
      return { ok: false, errorKey: "onboarding.error.save" };
    }
  }
  if (!(await post(doFetch, "/api/onboarding/steps", { step: "qa_templates", skipped }))) {
    return { ok: false, errorKey: "onboarding.error.save" };
  }
  const previews = await loadPreviews(deps);
  return previews ? { ok: true, previews } : { ok: false, errorKey: "onboarding.error.previews" };
}
