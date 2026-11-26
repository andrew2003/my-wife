import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import type { EventEnvelope } from "@my-wife/contracts";
import { createApp } from "../src/index";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });

const stepEvent = (userId: string): EventEnvelope =>
  ({
    id: "e1",
    type: "onboarding.step_completed",
    occurredAt: "2026-03-02T09:00:00Z",
    userId,
    schemaVersion: 1,
    payload: { step: "qa_templates", skipped: true },
  }) as EventEnvelope;

describe("GET /budget/sample-cycle", () => {
  it("requires the gateway user id", async () => {
    const app = await createApp(config);
    const res = await app.inject({ method: "GET", url: "/budget/sample-cycle" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 404 before the sample budget exists", async () => {
    const app = await createApp(config);
    const res = await app.inject({
      method: "GET",
      url: "/budget/sample-cycle",
      headers: { "x-user-id": "u1" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ ok: false, error: { code: "budget.cycle_not_found" } });
  });

  it("returns the generated cycle with its id and categories", async () => {
    const app = await createApp(config);
    await app.onOnboardingStepCompleted(stepEvent("u1"));
    const res = await app.inject({
      method: "GET",
      url: "/budget/sample-cycle",
      headers: { "x-user-id": "u1" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.data.cycle.id).toBe("string");
    expect(body.data.cycle.state).toBe("draft");
    expect(body.data.categories.length).toBeGreaterThan(0);
  });

  it("does not show another user's sample", async () => {
    const app = await createApp(config);
    await app.onOnboardingStepCompleted(stepEvent("u1"));
    const res = await app.inject({
      method: "GET",
      url: "/budget/sample-cycle",
      headers: { "x-user-id": "u2" },
    });
    expect(res.statusCode).toBe(404);
  });
});
