import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import type { EventEnvelope } from "@my-wife/contracts";
import { startAll, type Runner } from "../src/runner";

const USER = "0190a0a0-0000-7000-8000-0000000000f1";
const CYCLE = "22222222-2222-4222-8222-222222222222";
const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
let runner: Runner | undefined;

afterEach(async () => {
  await runner?.stop();
  runner = undefined;
});

function envelope(type: string, id: string, payload: Record<string, unknown>): EventEnvelope {
  return {
    id,
    type,
    userId: USER,
    occurredAt: "2026-11-02T00:00:00.000Z",
    schemaVersion: 1,
    payload,
  } as EventEnvelope;
}

describe("cycle and fault events in the dev runner", () => {
  it("delivers cycle.opened to rules, which then requires a contract", async () => {
    const delivered: string[] = [];
    runner = await startAll(config, {
      ephemeralPorts: true,
      onDelivered: (service, e) => void delivered.push(`${service}:${e.type}`),
    });
    await runner.publish(
      envelope("cycle.opened", "44444444-4444-4444-8444-444444444444", {
        cycleId: CYCLE,
        sequence: 1,
        firstDay: "2026-11-02",
      }),
    );
    expect(delivered).toContain("rules:cycle.opened");
    const res = await fetch(`${runner.urls.rules}/contracts/status`, {
      headers: { "x-user-id": USER },
    });
    const body = (await res.json()) as { data: { cycleId: string; contractRequired: boolean } };
    expect(body.data).toMatchObject({ cycleId: CYCLE, contractRequired: true });
  });

  it("delivers fault.detected to rules", async () => {
    const delivered: string[] = [];
    runner = await startAll(config, {
      ephemeralPorts: true,
      onDelivered: (service, e) => void delivered.push(`${service}:${e.type}`),
    });
    await runner.publish(
      envelope("fault.detected", "55555555-5555-4555-8555-555555555555", {
        signalRef: "sig-1",
        type: "wake_late",
        occurredAt: "2026-11-02T01:00:00.000Z",
        reason: "none",
        reasonRef: null,
        reasonKind: null,
        overlapsOutage: false,
      }),
    );
    expect(delivered).toContain("rules:fault.detected");
  });
});
