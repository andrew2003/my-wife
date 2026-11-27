import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { createApp } from "../src/index";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });

describe("POST /budget/cycles/approve", () => {
  it("requires the gateway user id", async () => {
    const app = await createApp(config);
    const res = await app.inject({ method: "POST", url: "/budget/cycles/approve", payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it("rejects an invalid body and an unknown cycle", async () => {
    const app = await createApp(config);
    const headers = { "x-user-id": "u1" };
    const bad = await app.inject({
      method: "POST",
      url: "/budget/cycles/approve",
      headers,
      payload: {},
    });
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({
      method: "POST",
      url: "/budget/cycles/approve",
      headers,
      payload: { cycleId: "c", commitmentId: "k" },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ ok: false, error: { code: "budget.cycle_not_found" } });
  });
});
