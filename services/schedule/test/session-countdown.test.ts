import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import type { EventEnvelope } from "@my-wife/contracts";
import { createApp } from "../src/index";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const H = { "x-user-id": "u1" };
const MIN = 60_000;

function setup() {
  let t = new Date("2026-11-23T08:00:00.000Z");
  const appP = createApp(config, {
    now: () => t,
    publish: (_e: EventEnvelope) => {},
  });
  return { appP, advance: (ms: number) => (t = new Date(t.getTime() + ms)) };
}

async function start(app: Awaited<ReturnType<typeof createApp>>) {
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
    payload: { taskId, durationMinutes: 50 },
  });
  return { res, taskId };
}

describe("session countdown source", () => {
  it("returns the server time with the view so clients can correct clock skew", async () => {
    const { appP } = setup();
    const app = await appP;
    const { res } = await start(app);
    const s = res.json().data.session;
    expect(s.serverNow).toBe("2026-11-23T08:00:00.000Z");
    expect(s.plannedEndAt).toBe("2026-11-23T08:50:00.000Z");
  });

  it("finds the active session of a task after a page reload", async () => {
    const { appP, advance } = setup();
    const app = await appP;
    const { res, taskId } = await start(app);
    advance(10 * MIN);
    const read = await app.inject({
      method: "GET",
      url: `/sessions/active?taskId=${taskId}`,
      headers: H,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().data.session.id).toBe(res.json().data.session.id);
    expect(read.json().data.session.remainingSeconds).toBe(40 * 60);
    const none = await app.inject({
      method: "GET",
      url: "/sessions/active?taskId=00000000-0000-4000-8000-000000000000",
      headers: H,
    });
    expect(none.statusCode).toBe(404);
  });
});
