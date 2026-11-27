import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { parseEvent, PlanWeekResponseSchema, type EventEnvelope } from "@my-wife/contracts";
import { createApp } from "../src/index";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const H = { "x-user-id": "u1" };

type App = Awaited<ReturnType<typeof createApp>>;

async function setup(settings: Record<string, unknown> = {}) {
  const events: EventEnvelope[] = [];
  const app = await createApp(config, {
    now: () => new Date("2026-11-22T08:00:00Z"),
    publish: (e: EventEnvelope) => void events.push(e),
    readSettings: async () => settings,
  });
  return { app, events };
}

const tpl = (estimatedMinutes: number, count = 2) => ({
  name: "Student week",
  tasks: Array.from({ length: count }, (_, i) => ({
    title: `Task ${i}`,
    dayOffset: i,
    kind: "desk",
    estimatedMinutes,
    monitoringProfile: "none",
  })),
});

const post = (app: App, url: string, payload: unknown, headers = H) =>
  app.inject({ method: "POST", url, headers, payload: payload as object });

async function draftWeek(app: App) {
  return (await post(app, "/weeks", { firstDay: "2026-11-23" })).json().data.week;
}

describe("weekly templates", () => {
  it("copies a saved template into the week and emits week.planned on approval", async () => {
    const { app, events } = await setup();
    const t = (await post(app, "/templates", tpl(60))).json().data.template;
    const week = await draftWeek(app);
    const planned = await post(app, `/weeks/${week.id}/plan`, { templateId: t.id });
    expect(planned.statusCode).toBe(200);
    expect(PlanWeekResponseSchema.safeParse(planned.json()).success).toBe(true);
    const day1 = await app.inject({ method: "GET", url: "/checklist?date=2026-11-24", headers: H });
    expect(day1.json().data.tasks.map((x: { title: string }) => x.title)).toEqual(["Task 1"]);
    expect(events).toHaveLength(0);
    const approved = await post(app, `/weeks/${week.id}/approve`, {});
    expect(approved.json().data.week.state).toBe("planned");
    const ev = events.filter((e) => e.type === "week.planned");
    expect(ev).toHaveLength(1);
    expect(parseEvent(ev[0]).success).toBe(true);
  });

  it("applies a template only once per week", async () => {
    const { app } = await setup();
    const t = (await post(app, "/templates", tpl(60))).json().data.template;
    const week = await draftWeek(app);
    await post(app, `/weeks/${week.id}/plan`, { templateId: t.id });
    const again = await post(app, `/weeks/${week.id}/plan`, { templateId: t.id });
    expect(again.statusCode).toBe(409);
    const day = await app.inject({ method: "GET", url: "/checklist?date=2026-11-23", headers: H });
    expect(day.json().data.tasks).toHaveLength(1);
  });

  it("rejects an unknown template and another user's template", async () => {
    const { app } = await setup();
    const t = (await post(app, "/templates", tpl(60))).json().data.template;
    const week = await draftWeek(app);
    const other = await post(
      app,
      `/weeks/${week.id}/plan`,
      { templateId: t.id },
      {
        "x-user-id": "u2",
      },
    );
    expect(other.statusCode).toBe(404);
    const unknown = await post(app, `/weeks/${week.id}/plan`, { templateId: "nope" });
    expect(unknown.statusCode).toBe(404);
  });

  it("rejects an invalid template", async () => {
    const { app } = await setup();
    const bad = tpl(60);
    bad.tasks[0]!.dayOffset = 9;
    expect((await post(app, "/templates", bad)).statusCode).toBe(400);
  });

  it("does not plan a week that is no longer a draft", async () => {
    const { app } = await setup();
    const week = await draftWeek(app);
    await post(app, `/weeks/${week.id}/approve`, {});
    expect((await post(app, `/weeks/${week.id}/plan`, {})).statusCode).toBe(409);
  });
});

describe("overloaded week", () => {
  it("shows overloaded with the excess before approval", async () => {
    // Default awake span 06:00-23:00 is 17h a day, 119h a week; plan 119h and 1 minute.
    const { app, events } = await setup();
    const t = (await post(app, "/templates", tpl(60 * 59 + 31, 2))).json().data.template;
    const week = await draftWeek(app);
    const res = await post(app, `/weeks/${week.id}/plan`, { templateId: t.id });
    expect(res.json().data).toMatchObject({ overloaded: true, overloadMinutes: 2 });
    expect(events).toHaveLength(0);
    expect((await post(app, `/weeks/${week.id}/approve`, {})).statusCode).toBe(200);
  });

  it("is not overloaded at exactly the available time, and follows the user's settings", async () => {
    const { app } = await setup({ "routine.wake.time": "07:00", "routine.sleep.start": "22:00" });
    const t = (await post(app, "/templates", tpl(7 * 15 * 60, 1))).json().data.template;
    const week = await draftWeek(app);
    const res = await post(app, `/weeks/${week.id}/plan`, { templateId: t.id });
    expect(res.json().data).toMatchObject({ overloaded: false, overloadMinutes: 0 });
  });
});
