import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import type { EventEnvelope } from "@my-wife/contracts";
import { SimClock } from "@my-wife/test-kit";
import { mountSessionJob, startAll, type Runner } from "../src/runner";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const MIN = 60_000;
let runner: Runner | undefined;

afterEach(async () => {
  await runner?.stop();
  runner = undefined;
});

describe("session job in the dev runner", () => {
  it("runs on the simulated clock and receives now as a parameter", async () => {
    const clock = new SimClock("2026-11-26T03:00:00.000Z");
    const events: EventEnvelope[] = [];
    runner = await startAll(config, {
      ephemeralPorts: true,
      schedule: { publish: (e) => void events.push(e), now: () => clock.now() },
    });
    mountSessionJob(runner, clock, MIN);
    const headers = { "content-type": "application/json", "x-user-id": "u1" };
    const task = await fetch(`${runner.urls.schedule}/tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Write",
        day: "2026-11-26",
        kind: "desk",
        monitoringProfile: "none",
      }),
    });
    const taskId = ((await task.json()) as { data: { task: { id: string } } }).data.task.id;
    const start = await fetch(`${runner.urls.schedule}/sessions/start`, {
      method: "POST",
      headers,
      body: JSON.stringify({ taskId, durationMinutes: 25 }),
    });
    expect(start.status).toBe(200);

    await clock.advanceBy(24 * MIN);
    expect(events.map((e) => e.type)).not.toContain("session.ended");
    await clock.advanceBy(2 * MIN);
    expect(events.filter((e) => e.type === "session.ended")).toHaveLength(1);
  });
});
