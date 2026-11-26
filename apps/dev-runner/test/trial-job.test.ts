import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import type { EventEnvelope } from "@my-wife/contracts";
import { SimClock, WEEK_MS } from "@my-wife/test-kit";
import { mountTrialJob, startAll, type Runner } from "../src/runner";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const USER = "11111111-1111-4111-8111-111111111111";
let runner: Runner | undefined;

afterEach(async () => {
  await runner?.stop();
  runner = undefined;
});

describe("trial job in the dev runner", () => {
  it("runs on the simulated clock and receives now as a parameter", async () => {
    const clock = new SimClock("2026-11-26T03:00:00.000Z");
    const events: EventEnvelope[] = [];
    runner = await startAll(config, {
      ephemeralPorts: true,
      rules: {
        publish: (e) => void events.push(e),
        now: () => clock.now(),
        readTrialSettings: async () => ({ weeks: 1, installmentsK: 1, finalAppealHours: 0 }),
      },
    });
    mountTrialJob(runner, clock, 24 * 3_600_000);

    const res = await fetch(`${runner.urls.rules}/events/contract-signed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "44444444-4444-4444-8444-444444444444",
        type: "contract.signed",
        userId: USER,
        occurredAt: clock.now().toISOString(),
        schemaVersion: 1,
        payload: {
          contractId: "33333333-3333-4333-8333-333333333333",
          cycleId: "22222222-2222-4222-8222-222222222222",
          version: 1,
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(events.map((e) => e.type)).toEqual(["trial.started"]);

    await clock.advanceBy(WEEK_MS - 1);
    expect(events.map((e) => e.type)).toEqual(["trial.started"]);
    await clock.advanceBy(24 * 3_600_000);
    expect(events.map((e) => e.type)).toEqual(["trial.started", "trial.ended", "trial.settled"]);
  });
});
