import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import type { EventEnvelope } from "@my-wife/contracts";
import { createApp } from "../src/index";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const H = { "x-user-id": "u1" };

async function setup(kind: "offline" | "desk" = "offline") {
  const events: EventEnvelope[] = [];
  const app = await createApp(config, {
    now: () => new Date("2026-11-23T08:00:00Z"),
    publish: (e) => void events.push(e),
  });
  const res = await app.inject({
    method: "POST",
    url: "/tasks",
    headers: H,
    payload: {
      title: "Yoga class",
      day: "2026-11-23",
      kind,
      estimatedMinutes: 60,
      monitoringProfile: kind === "offline" ? "offline_checkin" : "none",
    },
  });
  const taskId = res.json().data.task.id as string;
  const checkIn = (phase: string, headers: Record<string, string> = H) =>
    app.inject({ method: "POST", url: "/tasks/check-in", headers, payload: { taskId, phase } });
  return { app, taskId, events, checkIn };
}

describe("offline task check-ins", () => {
  it("records a start check-in without any monitoring session", async () => {
    const { app, taskId, events, checkIn } = await setup();
    const res = await checkIn("start");
    expect(res.statusCode).toBe(200);
    expect(res.json().data.task.state).toBe("in_progress");
    expect(res.json().data.checkIn).toMatchObject({ taskId, phase: "start", informational: true });
    expect(events.map((e) => e.type)).toEqual(["task.started"]);
    const active = await app.inject({ method: "GET", url: "/sessions/active", headers: H });
    expect(active.json().data?.session ?? null).toBeNull();
    expect(events.some((e) => e.type === "session.started")).toBe(false);
  });

  it("end check-in completes the task and carries no penalty", async () => {
    const { events, checkIn } = await setup();
    await checkIn("start");
    const res = await checkIn("end");
    expect(res.json().data.task.state).toBe("done");
    expect(events.map((e) => e.type)).toEqual(["task.started", "task.ended"]);
    expect(events.some((e) => e.type.startsWith("fault"))).toBe(false);
  });

  it("lists the check-ins of a task", async () => {
    const { app, taskId, checkIn } = await setup();
    await checkIn("start");
    await checkIn("end");
    const res = await app.inject({
      method: "GET",
      url: `/tasks/check-ins?taskId=${taskId}`,
      headers: H,
    });
    expect(res.json().data.checkIns.map((c: { phase: string }) => c.phase)).toEqual([
      "start",
      "end",
    ]);
  });

  it("rejects non-offline tasks, bad phases, wrong order and other users", async () => {
    const desk = await setup("desk");
    expect((await desk.checkIn("start")).json().error.code).toBe("schedule.task_not_offline");
    const o = await setup();
    expect((await o.checkIn("bogus")).statusCode).toBe(400);
    expect((await o.checkIn("end")).statusCode).toBe(409);
    await o.checkIn("start");
    expect((await o.checkIn("start")).statusCode).toBe(409);
    expect((await o.checkIn("start", { "x-user-id": "u2" })).statusCode).toBe(404);
  });
});
