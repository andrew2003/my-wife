import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { createApp } from "../src/index";
import type { ReviewOverrunOptions } from "../src/review";
import en from "../src/locales/en.json";
import vi from "../src/locales/vi.json";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const H = { "x-user-id": "u1" };
const MIN = 60_000;
type App = Awaited<ReturnType<typeof createApp>>;

function setup(reviewOverrun?: Partial<ReviewOverrunOptions>) {
  let t = new Date("2026-11-23T08:00:00Z");
  const appP = createApp(config, { now: () => t, reviewOverrun, publish: () => undefined });
  return {
    appP,
    advance: (ms: number) => (t = new Date(t.getTime() + ms)),
    setNow: (s: string) => (t = new Date(s)),
  };
}

const post = (app: App, url: string, payload: object = {}) =>
  app.inject({ method: "POST", url, headers: H, payload });

/** A task with an estimate that is worked for `actual` minutes in one session, then done. */
async function worked(
  app: App,
  advance: (ms: number) => Date,
  title: string,
  estimate: number,
  actual: number,
) {
  const created = await post(app, "/tasks", {
    title,
    day: "2026-11-24",
    kind: "desk",
    estimatedMinutes: estimate,
    monitoringProfile: "none",
  });
  const taskId = created.json().data.task.id as string;
  const s = await post(app, "/sessions/start", { taskId, durationMinutes: actual });
  const sessionId = s.json().data.session.id as string;
  advance(actual * MIN);
  await post(app, `/sessions/${sessionId}/stop`);
  await post(app, "/tasks/complete", { taskId });
  return taskId;
}

async function plannedWeek(app: App) {
  const week = await post(app, "/weeks", { firstDay: "2026-11-23" });
  const weekId = week.json().data.week.id as string;
  await app.inject({ method: "POST", url: `/weeks/${weekId}/approve`, headers: H });
  return weekId;
}

async function closedReview(app: App, weekId: string, setNow: (s: string) => Date) {
  setNow("2026-11-30T00:00:01Z");
  await app.inject({ method: "POST", url: "/jobs/week-boundary" });
  const res = await app.inject({ method: "GET", url: `/weeks/${weekId}/review`, headers: H });
  return res.json().data.review;
}

describe("weekly review suggestions", () => {
  it("suggests adjusting durations when several tasks repeatedly overran", async () => {
    const { appP, advance, setNow } = setup();
    const app = await appP;
    const weekId = await plannedWeek(app);
    const ids = [
      await worked(app, advance, "A", 30, 60),
      await worked(app, advance, "B", 30, 50),
      await worked(app, advance, "C", 60, 90),
    ];
    const review = await closedReview(app, weekId, setNow);
    const s = review.suggestions.find((x: { kind: string }) => x.kind === "adjust_durations");
    expect(s).toBeDefined();
    expect(s.informational).toBe(true);
    expect(s.messageKey).toBe("schedule.review.suggest_adjust_durations");
    expect(s.overranCount).toBe(3);
    expect(s.tasks.map((t: { taskId: string }) => t.taskId).sort()).toEqual([...ids].sort());
    expect(s.tasks.find((t: { taskId: string }) => t.taskId === ids[0])).toMatchObject({
      estimatedMinutes: 30,
      actualMinutes: 60,
      suggestedMinutes: 60,
    });
    expect(review.estimates).toMatchObject({ measured: 3, overran: 3 });
  });

  it("does not suggest anything for a single overrun or on-time work", async () => {
    const { appP, advance, setNow } = setup();
    const app = await appP;
    const weekId = await plannedWeek(app);
    await worked(app, advance, "A", 30, 60);
    await worked(app, advance, "B", 30, 30);
    await worked(app, advance, "C", 30, 35); // within the 20% tolerance
    const review = await closedReview(app, weekId, setNow);
    expect(review.suggestions).toEqual([]);
    expect(review.estimates).toMatchObject({ measured: 3, overran: 1 });
  });

  it("takes the tolerance and the repeat count from options", async () => {
    const { appP, advance, setNow } = setup({ tolerancePercent: 5, minOverranTasks: 2 });
    const app = await appP;
    const weekId = await plannedWeek(app);
    await worked(app, advance, "A", 30, 33);
    await worked(app, advance, "B", 30, 34);
    const review = await closedReview(app, weekId, setNow);
    expect(review.suggestions).toHaveLength(1);
  });

  it("has the suggestion text in both locale files", () => {
    for (const l of [en, vi] as Record<string, string>[]) {
      expect(l["schedule.review.suggest_adjust_durations"]).toContain("{count}");
    }
  });
});
