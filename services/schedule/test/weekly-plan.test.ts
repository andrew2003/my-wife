import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { parseEvent, type EventEnvelope } from "@my-wife/contracts";
import { createApp } from "../src/index";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const H = { "x-user-id": "u1" };

type App = Awaited<ReturnType<typeof createApp>>;

function setup(start = "2026-11-23T08:00:00Z") {
  let t = new Date(start);
  const events: EventEnvelope[] = [];
  const appP = createApp(config, {
    now: () => t,
    publish: (e: EventEnvelope) => void events.push(e),
  });
  return { appP, events, setNow: (s: string) => (t = new Date(s)) };
}

const task = {
  title: "Write report",
  day: "2026-11-23",
  kind: "desk",
  estimatedMinutes: 60,
  monitoringProfile: "none",
};

async function create(app: App, extra = {}) {
  const res = await app.inject({ method: "POST", url: "/tasks", headers: H, payload: { ...task, ...extra } });
  return res.json().data.task.id as string;
}

describe("task state machine", () => {
  it("ticking a started task done emits task.ended and sends no chat message", async () => {
    const { appP, events } = setup();
    const app = await appP;
    const taskId = await create(app);
    const start = await app.inject({ method: "POST", url: "/tasks/start", headers: H, payload: { taskId } });
    expect(start.statusCode).toBe(200);
    const done = await app.inject({ method: "POST", url: "/tasks/complete", headers: H, payload: { taskId } });
    expect(done.statusCode).toBe(200);
    expect(events.map((e) => e.type)).toEqual(["task.started", "task.ended"]);
    const list = await app.inject({ method: "GET", url: "/checklist?date=2026-11-23", headers: H });
    expect(list.json().data.tasks[0].state).toBe("done");
  });

  it("ticking a planned task done directly also ends it", async () => {
    const { appP, events } = setup();
    const app = await appP;
    const taskId = await create(app);
    const done = await app.inject({ method: "POST", url: "/tasks/complete", headers: H, payload: { taskId } });
    expect(done.statusCode).toBe(200);
    expect(events.map((e) => e.type)).toEqual(["task.started", "task.ended"]);
  });

  it("rejects start for a task not in the plan", async () => {
    const { appP, events } = setup();
    const app = await appP;
    const res = await app.inject({ method: "POST", url: "/tasks/start", headers: H, payload: { taskId: "nope" } });
    expect(res.statusCode).toBe(404);
    expect(res.json().ok).toBe(false);
    const taskId = await create(app);
    await app.inject({ method: "POST", url: "/tasks/complete", headers: H, payload: { taskId } });
    const again = await app.inject({ method: "POST", url: "/tasks/start", headers: H, payload: { taskId } });
    expect(again.statusCode).toBe(409);
    const other = await app.inject({
      method: "POST",
      url: "/tasks/start",
      headers: { "x-user-id": "u2" },
      payload: { taskId },
    });
    expect(other.statusCode).toBe(404);
    expect(events.map((e) => e.type)).toEqual(["task.started", "task.ended"]);
  });
});

describe("week boundary job", () => {
  const job = (app: App) => app.inject({ method: "POST", url: "/jobs/week-boundary" });

  it("emits week.closed exactly once even when the job runs twice", async () => {
    const { appP, events, setNow } = setup();
    const app = await appP;
    const created = await app.inject({
      method: "POST",
      url: "/weeks",
      headers: H,
      payload: { firstDay: "2026-11-23" },
    });
    const weekId = created.json().data.week.id as string;
    const approved = await app.inject({ method: "POST", url: `/weeks/${weekId}/approve`, headers: H });
    expect(approved.json().data.week.state).toBe("planned");
    await job(app);
    await job(app);
    expect(events.filter((e) => e.type === "week.closed")).toHaveLength(0);
    setNow("2026-11-30T00:00:01Z");
    await job(app);
    await job(app);
    const closed = events.filter((e) => e.type === "week.closed");
    expect(closed).toHaveLength(1);
    expect(closed[0]!.payload).toMatchObject({ weekId, firstDay: "2026-11-23" });
    const w = await app.inject({ method: "GET", url: "/weeks/current", headers: H });
    expect(w.json().data.week.state).toBe("reviewing");
  });

  it("retries the emission after a failed publish without duplicating it", async () => {
    let fail = true;
    const events: EventEnvelope[] = [];
    let t = new Date("2026-11-23T08:00:00Z");
    const app = await createApp(config, {
      now: () => t,
      publish: (e: EventEnvelope) => {
        if (e.type === "week.closed" && fail) throw new Error("bus down");
        events.push(e);
      },
    });
    const created = await app.inject({
      method: "POST",
      url: "/weeks",
      headers: H,
      payload: { firstDay: "2026-11-23" },
    });
    const id = created.json().data.week.id as string;
    await app.inject({ method: "POST", url: `/weeks/${id}/approve`, headers: H });
    t = new Date("2026-12-01T00:00:00Z");
    await job(app);
    fail = false;
    await job(app);
    await job(app);
    expect(events.filter((e) => e.type === "week.closed")).toHaveLength(1);
  });
});

describe("review fixes", () => {
  const job = (app: App) => app.inject({ method: "POST", url: "/jobs/week-boundary" });
  const slowPublish = (events: EventEnvelope[]) => async (e: EventEnvelope) => {
    await new Promise((r) => setTimeout(r, 10));
    events.push(e);
  };
  const post = (app: App, url: string, payload: unknown) =>
    app.inject({ method: "POST", url, headers: H, payload: payload as object });

  it("emits week.closed once when two boundary runs overlap with an async publish", async () => {
    const events: EventEnvelope[] = [];
    const app = await createApp(config, {
      now: () => new Date("2026-12-01T00:00:00Z"),
      publish: slowPublish(events),
    });
    const created = await post(app, "/weeks", { firstDay: "2026-11-23" });
    await app.inject({ method: "POST", url: `/weeks/${created.json().data.week.id}/approve`, headers: H });
    await Promise.all([job(app), job(app)]);
    expect(events.filter((e) => e.type === "week.closed")).toHaveLength(1);
  });

  it("emits task.started once for concurrent starts", async () => {
    const events: EventEnvelope[] = [];
    const app = await createApp(config, {
      now: () => new Date("2026-11-23T08:00:00Z"),
      publish: slowPublish(events),
    });
    const taskId = await create(app);
    const start = () => post(app, "/tasks/start", { taskId });
    const codes = (await Promise.all([start(), start()])).map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 409]);
    expect(events.filter((e) => e.type === "task.started")).toHaveLength(1);
  });

  it("rolls the task back when the publish fails so it can be retried", async () => {
    let fail = true;
    const events: EventEnvelope[] = [];
    const app = await createApp(config, {
      now: () => new Date("2026-11-23T08:00:00Z"),
      publish: (e: EventEnvelope) => {
        if (fail) throw new Error("bus down");
        events.push(e);
      },
    });
    const taskId = await create(app);
    expect((await post(app, "/tasks/start", { taskId })).statusCode).toBe(500);
    fail = false;
    expect((await post(app, "/tasks/start", { taskId })).statusCode).toBe(200);
    expect(events).toHaveLength(1);
  });

  it("publishes only schema-valid events, and only the task events for a tick", async () => {
    const { appP, events } = setup();
    const app = await appP;
    const taskId = await create(app);
    await post(app, "/tasks/complete", { taskId });
    expect(events.map((e) => e.type)).toEqual(["task.started", "task.ended"]);
    const w = await post(app, "/weeks", { firstDay: "2026-11-23" });
    await app.inject({ method: "POST", url: `/weeks/${w.json().data.week.id}/approve`, headers: H });
    expect(events.map((e) => e.type)).toEqual(["task.started", "task.ended", "week.planned"]);
    for (const e of events) expect(parseEvent(e)).toMatchObject({ success: true });
  });

  it("validates week.closed against the contract", async () => {
    const { appP, events, setNow } = setup();
    const app = await appP;
    const w = await post(app, "/weeks", { firstDay: "2026-11-23" });
    await app.inject({ method: "POST", url: `/weeks/${w.json().data.week.id}/approve`, headers: H });
    setNow("2026-12-01T00:00:00Z");
    await job(app);
    const closed = events.find((e) => e.type === "week.closed")!;
    expect(parseEvent(closed)).toMatchObject({ success: true });
  });

  it("moves a planned week to active when its first day arrives, without closing it", async () => {
    const { appP, events, setNow } = setup("2026-11-20T08:00:00Z");
    const app = await appP;
    const w = await post(app, "/weeks", { firstDay: "2026-11-23" });
    await app.inject({ method: "POST", url: `/weeks/${w.json().data.week.id}/approve`, headers: H });
    await job(app);
    const state = async () =>
      (await app.inject({ method: "GET", url: "/weeks/current", headers: H })).json().data.week.state;
    expect(await state()).toBe("planned");
    setNow("2026-11-23T00:00:00Z");
    await job(app);
    expect(await state()).toBe("active");
    expect(events.map((e) => e.type)).toEqual(["week.planned"]);
  });

  it("takes the default estimate from the user setting, falling back to the registry default", async () => {
    const { estimatedMinutes: _e, ...noEstimate } = task;
    for (const [answers, expected] of [
      [{ "schedule.task_default_minutes": 45 }, 45],
      [{}, 30],
    ] as const) {
      const app = await createApp(config, {
        now: () => new Date("2026-11-23T08:00:00Z"),
        readSettings: async () => answers,
      });
      const res = await post(app, "/tasks", noEstimate);
      expect(res.json().data.task.estimatedMinutes).toBe(expected);
    }
  });
});
