import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import type { EventEnvelope } from "@my-wife/contracts";
import { createApp } from "../src/index";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const T0 = Date.parse("2026-11-26T03:00:00.000Z");

async function setup() {
  const events: EventEnvelope[] = [];
  const app = await createApp(config, {
    now: () => new Date(T0 + 6000),
    publish: (e: EventEnvelope) => void events.push(e),
    readSettings: async () => ({}),
  });
  const call = (url: string, payload: unknown) =>
    app.inject({ method: "POST", url, headers: { "x-user-id": "u1" }, payload: payload as object });
  const sessionId = (
    await call("/sessions/start", { taskId: "t1", profile: "camera", deviceId: "dev-a" })
  ).json().data.sessionId as string;
  return { app, events, call, sessionId };
}

describe("the monitor service never accepts a video frame", () => {
  it("rejects a heartbeat that carries a frame field or an image in an event", async () => {
    const s = await setup();
    const sentAt = new Date(T0 + 6000).toISOString();
    const withField = await s.call("/heartbeat", {
      sessionId: s.sessionId,
      sentAt,
      events: [],
      frame: "data:image/jpeg;base64,AAAA",
    });
    expect(withField.statusCode).toBe(400);
    const inEvent = await s.call("/heartbeat", {
      sessionId: s.sessionId,
      sentAt,
      events: [
        { type: "no_face", startedAt: sentAt, confidence: 0.9, image: "AAAA", pixels: [1, 2] },
      ],
    });
    expect(inEvent.statusCode).toBe(400);
    const accepted = await s.call("/heartbeat", { sessionId: s.sessionId, sentAt, events: [] });
    expect(accepted.statusCode).toBe(200);
  });

  it("exposes no frame or image route", async () => {
    const s = await setup();
    for (const url of ["/frames", "/frame", "/images", "/appeals/frame", "/heartbeat/frame"]) {
      const res = await s.call(url, { sessionId: s.sessionId, imageBase64: "AAAA" });
      expect(res.statusCode).toBe(404);
    }
  });

  it("rejects binary bodies on the heartbeat", async () => {
    const s = await setup();
    const res = await s.app.inject({
      method: "POST",
      url: "/heartbeat",
      headers: { "x-user-id": "u1", "content-type": "image/jpeg" },
      payload: Buffer.from([0xff, 0xd8, 0xff]),
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it("publishes no event that carries image data", async () => {
    const s = await setup();
    await s.call("/heartbeat", {
      sessionId: s.sessionId,
      sentAt: new Date(T0 + 6000).toISOString(),
      events: [{ type: "yawn", startedAt: new Date(T0 + 5000).toISOString(), confidence: 0.9 }],
    });
    expect(JSON.stringify(s.events)).not.toMatch(/data:image|base64|pixels/i);
  });
});
