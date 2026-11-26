import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { parseEvent, type EventEnvelope } from "@my-wife/contracts";
import { createApp } from "../src/index";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const H = { "x-user-id": "u1" };
const MIN = 60_000;

function setup(start = "2026-11-23T08:00:00.000Z") {
  let t = new Date(start);
  const events: EventEnvelope[] = [];
  const appP = createApp(config, {
    now: () => t,
    publish: (e: EventEnvelope) => void events.push(e),
  });
  return { appP, events, advance: (ms: number) => (t = new Date(t.getTime() + ms)) };
}

async function startSession(app: Awaited<ReturnType<typeof createApp>>, extra = {}) {
  const created = await app.inject({
    method: "POST",
    url: "/tasks",
    headers: H,
    payload: { title: "Write", day: "2026-11-23", kind: "desk", monitoringProfile: "none" },
  });
  const taskId = created.json().data.task.id as string;
  const res = await app.inject({
    method: "POST",
    url: "/sessions/start",
    headers: H,
    payload: { taskId, ...extra },
  });
  return { res, taskId };
}

describe("work sessions", () => {
  it("derives the remaining time from the stored start and duration", async () => {
    const { appP, events, advance } = setup();
    const app = await appP;
    const { res } = await startSession(app, { durationMinutes: 50 });
    expect(res.statusCode).toBe(200);
    const id = res.json().data.session.id as string;
    expect(res.json().data.session.startedAt).toBe("2026-11-23T08:00:00.000Z");
    expect(events.map((e) => e.type)).toEqual(["task.started", "session.started"]);
    for (const e of events) expect(parseEvent(e).success).toBe(true);

    advance(20 * MIN);
    const read = await app.inject({ method: "GET", url: `/sessions/${id}`, headers: H });
    expect(read.json().data.session.remainingSeconds).toBe(30 * 60);
    advance(40 * MIN);
    const late = await app.inject({ method: "GET", url: `/sessions/${id}`, headers: H });
    expect(late.json().data.session.remainingSeconds).toBe(0);
  });

  it("ignores a client-supplied start time and uses the pomodoro default", async () => {
    const { appP } = setup();
    const app = await appP;
    const { res } = await startSession(app, { startedAt: "2020-01-01T00:00:00.000Z" });
    expect(res.json().data.session.startedAt).toBe("2026-11-23T08:00:00.000Z");
    expect(res.json().data.session.durationMinutes).toBe(25);
  });

  it("emits session.ended once when the end is reached, with now as a parameter", async () => {
    const { appP, events, advance } = setup();
    const app = await appP;
    await startSession(app, { durationMinutes: 25 });
    advance(24 * MIN);
    await app.runSessionJob(new Date("2026-11-23T08:24:00.000Z"));
    expect(events.filter((e) => e.type === "session.ended")).toHaveLength(0);
    await app.runSessionJob(new Date("2026-11-23T08:26:00.000Z"));
    await app.runSessionJob(new Date("2026-11-23T08:27:00.000Z"));
    const ended = events.filter((e) => e.type === "session.ended");
    expect(ended).toHaveLength(1);
    expect(parseEvent(ended[0]!).success).toBe(true);
    expect((ended[0]!.payload as { endedAt: string }).endedAt).toBe("2026-11-23T08:25:00.000Z");
  });

  it("rejects a second active session for the same task and unknown tasks", async () => {
    const { appP } = setup();
    const app = await appP;
    const { taskId } = await startSession(app);
    const again = await app.inject({
      method: "POST",
      url: "/sessions/start",
      headers: H,
      payload: { taskId },
    });
    expect(again.statusCode).toBe(409);
    const missing = await app.inject({
      method: "POST",
      url: "/sessions/start",
      headers: H,
      payload: { taskId: "5f1f3c0e-7a52-4a6e-9b1b-2f6f0c0f9a11" },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("lets the user stop a session early at the server time", async () => {
    const { appP, events, advance } = setup();
    const app = await appP;
    const { res } = await startSession(app, { durationMinutes: 50 });
    const id = res.json().data.session.id as string;
    advance(10 * MIN);
    const stop = await app.inject({ method: "POST", url: `/sessions/${id}/stop`, headers: H });
    expect(stop.statusCode).toBe(200);
    expect(stop.json().data.session.endedAt).toBe("2026-11-23T08:10:00.000Z");
    advance(60 * MIN);
    await app.runSessionJob(new Date("2026-11-23T09:10:00.000Z"));
    expect(events.filter((e) => e.type === "session.ended")).toHaveLength(1);
  });
});
