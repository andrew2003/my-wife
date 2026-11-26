import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi as vitest } from "vitest";
import en from "../locales/en.json";
import vi from "../locales/vi.json";
import { OnboardingWizardView } from "../components/onboarding-wizard-view";
import {
  QUESTIONS,
  buildAnswers,
  finishQuestions,
  type Previews,
  type ScheduleBlockView,
} from "../lib/onboarding";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const blocks: ScheduleBlockView[] = [
  {
    titleKey: "schedule.sample.wake",
    start: "06:30",
    end: "06:30",
    type: "routine",
    editable: true,
  },
  {
    titleKey: "schedule.sample.sleep",
    start: "23:00",
    end: "06:30",
    type: "routine",
    editable: true,
  },
];
const budget = {
  cycle: { weeks: 4, firstDay: "2026-11-26" },
  categories: [{ id: "c1", name: "Food", shortCode: "AN", cycleLimitVnd: 2_700_000 }],
};

/** A fake gateway: records calls and answers the four onboarding routes. */
function gateway(overrides: Record<string, () => Response> = {}) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const f = async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const key = `${init?.method ?? "GET"} ${url}`;
    if (overrides[key]) return overrides[key]!();
    if (url === "/api/onboarding/setup-answers") return json(200, { ok: true, data: {} });
    if (url === "/api/onboarding/steps") return json(200, { ok: true, data: {} });
    if (url === "/api/sample-schedule") return json(200, { ok: true, data: { blocks } });
    if (url === "/api/budget/sample-cycle") return json(200, { ok: true, data: budget });
    return json(404, {});
  };
  return { f: f as never, calls };
}

const noWait = async () => {};

describe("questions", () => {
  it("has wake time, sleep start and cycle weeks, all with locale keys", () => {
    expect(QUESTIONS.map((q) => q.setting)).toEqual([
      "routine.wake.time",
      "routine.sleep.start",
      "budget.cycle_weeks",
    ]);
    for (const q of QUESTIONS) {
      expect(vi).toHaveProperty([q.labelKey]);
      expect(en).toHaveProperty([q.labelKey]);
    }
  });

  it("keeps only filled, valid answers", () => {
    expect(
      buildAnswers({
        "routine.wake.time": "06:30",
        "routine.sleep.start": "",
        "budget.cycle_weeks": "5",
      }),
    ).toEqual({ ok: true, answers: { "routine.wake.time": "06:30", "budget.cycle_weeks": 5 } });
    expect(buildAnswers({})).toEqual({ ok: true, answers: {} });
    expect(buildAnswers({ "routine.wake.time": "25:99" }).ok).toBe(false);
    expect(buildAnswers({ "budget.cycle_weeks": "0" }).ok).toBe(false);
  });
});

describe("finishQuestions", () => {
  it("saves the answers, completes the step and returns the generated schedule and budget", async () => {
    const { f, calls } = gateway();
    const result = await finishQuestions({ "routine.wake.time": "06:30" }, false, {
      fetch: f,
      sleep: noWait,
    });
    expect(result).toEqual({ ok: true, previews: { schedule: blocks, budget } });
    expect(calls[0]).toMatchObject({
      url: "/api/onboarding/setup-answers",
      method: "POST",
      body: { answers: { "routine.wake.time": "06:30" } },
    });
    expect(calls[1]).toMatchObject({
      url: "/api/onboarding/steps",
      body: { step: "qa_templates", skipped: false },
    });
  });

  it("on Skip sends no answers, completes the step as skipped and shows the standard templates", async () => {
    const { f, calls } = gateway();
    const result = await finishQuestions({}, true, { fetch: f, sleep: noWait });
    expect(result.ok).toBe(true);
    expect(calls.some((c) => c.url === "/api/onboarding/setup-answers")).toBe(false);
    expect(calls[0]).toMatchObject({ body: { step: "qa_templates", skipped: true } });
    expect(calls.map((c) => c.url)).toContain("/api/sample-schedule");
  });

  it("does not complete the step when saving answers fails", async () => {
    const { f, calls } = gateway({
      "POST /api/onboarding/setup-answers": () => json(400, { ok: false }),
    });
    const result = await finishQuestions({ "budget.cycle_weeks": 4 }, false, {
      fetch: f,
      sleep: noWait,
    });
    expect(result).toEqual({ ok: false, errorKey: "onboarding.error.save" });
    expect(calls.some((c) => c.url === "/api/onboarding/steps")).toBe(false);
  });

  it("waits for the previews to be generated and then gives up with an error", async () => {
    let n = 0;
    const slow = gateway({
      "GET /api/sample-schedule": () =>
        ++n < 3 ? json(404, { ok: false }) : json(200, { ok: true, data: { blocks } }),
    });
    const sleep = vitest.fn(noWait);
    expect((await finishQuestions({}, true, { fetch: slow.f, sleep })).ok).toBe(true);
    expect(sleep).toHaveBeenCalledTimes(2);

    const never = gateway({ "GET /api/budget/sample-cycle": () => json(404, { ok: false }) });
    expect(await finishQuestions({}, true, { fetch: never.f, sleep: noWait, attempts: 3 })).toEqual(
      { ok: false, errorKey: "onboarding.error.previews" },
    );
  });
});

describe("OnboardingWizardView", () => {
  const view = (props: Record<string, unknown>) =>
    renderToStaticMarkup(
      createElement(OnboardingWizardView, {
        locale: "vi",
        phase: "questions",
        values: {},
        busy: false,
        errorKey: null,
        previews: null,
        onChange: () => {},
        onContinue: () => {},
        onSkip: () => {},
        onRetry: () => {},
        ...props,
      } as never),
    );

  it("shows every question with a Skip button, in both locales", () => {
    const html = view({});
    for (const q of QUESTIONS) expect(html).toContain((vi as Record<string, string>)[q.labelKey]);
    expect(html).toContain(vi["onboarding.skip"]);
    expect(html).toContain(vi["onboarding.continue"]);
    expect(view({ locale: "en" })).toContain(en["onboarding.skip"]);
  });

  it("shows loading and error states", () => {
    expect(view({ phase: "loading" })).toContain(vi["onboarding.loading"]);
    expect(view({ errorKey: "onboarding.error.previews" })).toContain(
      vi["onboarding.error.previews"],
    );
  });

  it("shows the generated schedule and budget for review", () => {
    const previews: Previews = { schedule: blocks, budget };
    const html = view({ phase: "review", previews });
    expect(html).toContain(vi["schedule.sample.wake"]);
    expect(html).toContain("06:30");
    expect(html).toContain("Food");
    expect(html).toContain(new Intl.NumberFormat("vi-VN").format(2_700_000));
  });

  it("has an empty state when a preview has no rows", () => {
    const html = view({
      phase: "review",
      previews: { schedule: [], budget: { ...budget, categories: [] } },
    });
    expect(html).toContain(vi["onboarding.review.schedule_empty"]);
    expect(html).toContain(vi["onboarding.review.budget_empty"]);
  });

  it("has every sample block title in both locales", () => {
    const keys = [
      "wake",
      "hygiene",
      "top_three",
      "deep_work",
      "lunch",
      "work",
      "exercise_dinner",
      "study",
      "reflection",
      "sleep",
    ];
    for (const k of keys) {
      expect(vi).toHaveProperty([`schedule.sample.${k}`]);
      expect(en).toHaveProperty([`schedule.sample.${k}`]);
    }
  });
});
