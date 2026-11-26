import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { createMemoryTicketStore, createMemoryUrgentStore } from "@my-wife/monitor";
import { SimClock } from "@my-wife/test-kit";
import { mountGapCheckJob, startAll, type Runner } from "../src/runner";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const SEC = 1000;
let runner: Runner | undefined;

afterEach(async () => {
  await runner?.stop();
  runner = undefined;
});

describe("heartbeat gap check in the dev runner", () => {
  it("runs on the simulated clock and receives now as a parameter", async () => {
    const clock = new SimClock("2026-11-26T03:00:00.000Z");
    const tickets = createMemoryTicketStore();
    const urgent = createMemoryUrgentStore();
    runner = await startAll(config, {
      ephemeralPorts: true,
      monitor: { now: () => clock.now(), state: { tickets, urgent } },
    });
    mountGapCheckJob(runner, clock, 5 * SEC);
    const headers = { "content-type": "application/json", "x-user-id": "u1" };
    const body = (deviceId: string) =>
      JSON.stringify({ taskId: null, profile: "camera", deviceId });
    const start = await fetch(`${runner.urls.monitor}/sessions/start`, {
      method: "POST",
      headers,
      body: body("dev-a"),
    });
    expect(start.status).toBe(200);
    const second = await fetch(`${runner.urls.monitor}/sessions/start`, {
      method: "POST",
      headers,
      body: body("dev-b"),
    });
    expect(second.status).toBe(409);

    // The registry default gap is 30 s.
    await clock.advanceBy(25 * SEC);
    expect(tickets.all()).toHaveLength(0);
    await clock.advanceBy(10 * SEC);
    expect(tickets.all()).toHaveLength(1);
    expect(urgent.all()).toHaveLength(1);
    expect(urgent.all()[0]?.class).toBe("urgent");
    // Later runs of the job do not open a second ticket for the same gap.
    await clock.advanceBy(60 * SEC);
    expect(tickets.all()).toHaveLength(1);
  });
});
