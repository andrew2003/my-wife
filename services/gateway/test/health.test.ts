import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { createApp, SERVICE_NAME } from "../src/index";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });

describe("gateway service", () => {
  it("answers /health", async () => {
    const app = await createApp(config);
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", service: SERVICE_NAME });
  });
});
