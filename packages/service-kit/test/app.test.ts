import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createServiceApp } from "../src/index";

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      for (const l of String(chunk).split("\n").filter(Boolean)) lines.push(JSON.parse(l));
      cb();
    },
  });
  return { lines, stream };
}

describe("createServiceApp", () => {
  it("answers /health with the service name", async () => {
    const app = createServiceApp({ name: "budget", logLevel: "silent" });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", service: "budget", nats: "disabled" });
  });

  it("generates a trace id and returns it in the response header", async () => {
    const app = createServiceApp({ name: "budget", logLevel: "silent" });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.headers["x-trace-id"]).toMatch(/.+/);
  });

  it("keeps an incoming trace id and writes JSON logs carrying it", async () => {
    const { lines, stream } = capture();
    const app = createServiceApp({ name: "budget", logLevel: "info", logStream: stream });
    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-trace-id": "trace-123" },
    });
    expect(res.headers["x-trace-id"]).toBe("trace-123");
    expect(lines.some((l) => l.traceId === "trace-123" && l.service === "budget")).toBe(true);
  });

  it("reports nats down when the connection is closed", async () => {
    const app = createServiceApp({
      name: "budget",
      logLevel: "silent",
      nats: { isClosed: () => true },
    });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: "degraded", nats: "down" });
  });

  it("does not log secrets passed in an authorization header", async () => {
    const { lines, stream } = capture();
    const app = createServiceApp({ name: "budget", logLevel: "info", logStream: stream });
    await app.inject({
      method: "GET",
      url: "/health",
      headers: { authorization: "Bearer SECRET" },
    });
    expect(JSON.stringify(lines)).not.toContain("SECRET");
  });
});
