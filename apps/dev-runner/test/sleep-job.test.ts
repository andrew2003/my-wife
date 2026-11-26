import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import type { EventEnvelope } from "@my-wife/contracts";
import { SimClock } from "@my-wife/test-kit";
import { mountSleepJob, startAll, type Runner } from "../src/runner";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const MIN = 60_000;
let runner: Runner | undefined;

afterEach(async () => {
  await runner?.stop();
  runner = undefined;
});

describe("sleep job in the dev runner", () => {
  it("runs on the simulated clock and receives now as a parameter", async () => {
    const clock = new SimClock("2026-11-23T15:00:00.000Z");
    const events: EventEnvelope[] = [];
    runner = await startAll(config, {
      ephemeralPorts: true,
      schedule: { publish: (e) => void events.push(e), now: () => clock.now() },
    });
    mountSleepJob(runner, clock, MIN);
    await fetch(`${runner.urls.schedule}/weeks`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-user-id": "u1" },
      body: JSON.stringify({ firstDay: "2026-11-23" }),
    });
    await clock.advanceBy(44 * MIN);
    expect(events.filter((e) => e.type === "routine.reminder_due")).toHaveLength(0);
    await clock.advanceBy(2 * MIN);
    expect(events.filter((e) => e.type === "routine.reminder_due")).toHaveLength(1);
    await clock.advanceBy(30 * MIN);
    const night = await fetch(`${runner.urls.schedule}/sleep/night?date=2026-11-23`, {
      headers: { "x-user-id": "u1" },
    });
    expect(((await night.json()) as { data: { night: { state: string } } }).data.night.state).toBe(
      "sleeping",
    );
  });
});
