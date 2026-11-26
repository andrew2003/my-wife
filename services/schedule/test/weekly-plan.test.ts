import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import type { EventEnvelope } from "@my-wife/contracts";
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
    // Only the two task events leave the service: no ask.* or other chat-bound event.
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
