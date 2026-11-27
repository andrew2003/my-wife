import { describe, expect, it } from "vitest";
import { HeartbeatRequestSchema } from "@my-wife/contracts";
import {
  createCameraMonitor,
  httpHeartbeatSender,
  type DetectedEvent,
} from "../lib/camera-monitor";
import { APPEAL_FRAME_PATH, createFrameGuardedFetch } from "../lib/frame-guard";

const SESSION = "0190a0a0-0000-7000-8000-000000000001";
/** A fake camera frame: a recognizable byte pattern standing in for a sample video frame. */
const FRAME_BYTES = Uint8Array.from({ length: 64 }, (_, i) => (i * 7 + 13) % 256);
const BIG_FRAME = Uint8Array.from({ length: 2048 }, (_, i) => (i * 31 + 5) % 256);
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");

interface Recorded {
  url: string;
  init?: RequestInit;
}

function network() {
  const requests: Recorded[] = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    requests.push({ url, init });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { requests, fakeFetch };
}

async function monitoredRun(doFetch: typeof fetch, events: DetectedEvent[] = []) {
  let now = Date.parse("2026-11-26T08:00:00.000Z");
  let tick: (() => void) | null = null;
  let visibility: (hidden: boolean) => void = () => undefined;
  let emitted = false;
  const monitor = createCameraMonitor({
    sessionId: SESSION,
    heartbeatEverySeconds: 10,
    clock: { now: () => now },
    ticker: (fn) => ((tick = fn), () => undefined),
    onVisibility: (cb) => ((visibility = cb), () => undefined),
    grabFrame: () => ({ data: FRAME_BYTES }),
    analyzer: {
      analyze: () => {
        if (emitted) return [];
        emitted = true;
        return events;
      },
    },
    send: httpHeartbeatSender(doFetch),
  });
  monitor.start();
  const advance = (s: number) => {
    for (let i = 0; i < s; i++) {
      now += 1000;
      tick?.();
    }
  };
  advance(25);
  visibility(true);
  advance(20);
  visibility(false);
  advance(20);
  monitor.stop();
  await Promise.resolve();
}

describe("no frame leaves the device during a monitored run", () => {
  it("inspects every request of a full run: none carries frame bytes", async () => {
    const net = network();
    await monitoredRun(createFrameGuardedFetch(net.fakeFetch), [
      { type: "no_face", startedAt: "2026-11-26T08:00:03.000Z", confidence: 0.9 },
    ]);
    expect(net.requests.length).toBeGreaterThan(3);
    for (const r of net.requests) {
      expect(r.url).toBe("/api/monitor/heartbeat");
      expect(typeof r.init?.body).toBe("string");
      const text = r.init?.body as string;
      expect(text).not.toContain(b64(FRAME_BYTES));
      expect(text).not.toContain(hex(FRAME_BYTES));
      expect(text).not.toMatch(/data:image|data:video|base64/i);
      expect(HeartbeatRequestSchema.safeParse(JSON.parse(text)).success).toBe(true);
      expect(new Headers(r.init?.headers).get("content-type")).toBe("application/json");
    }
  });
});

describe("frame guard", () => {
  const post = (url: string, body: unknown, headers: Record<string, string> = {}) => {
    const net = network();
    const guarded = createFrameGuardedFetch(net.fakeFetch);
    return { net, run: () => guarded(url, { method: "POST", headers, body: body as BodyInit }) };
  };

  it.each([
    ["a Blob", () => new Blob([FRAME_BYTES], { type: "image/jpeg" })],
    ["an ArrayBuffer", () => FRAME_BYTES.buffer],
    ["a typed array", () => FRAME_BYTES],
    ["form data", () => new FormData()],
  ])("blocks %s to any endpoint", async (_n, make) => {
    const p = post("/api/monitor/heartbeat", make());
    await expect(p.run()).rejects.toThrow(/frame/i);
    expect(p.net.requests).toHaveLength(0);
  });

  it("blocks image content types and embedded image data", async () => {
    const a = post("/api/monitor/heartbeat", "x", { "content-type": "image/png" });
    await expect(a.run()).rejects.toThrow();
    const b = post("/api/monitor/heartbeat", JSON.stringify({ f: "data:image/jpeg;base64,AAAA" }));
    await expect(b.run()).rejects.toThrow();
    const c = post("/api/other", JSON.stringify({ blob: b64(BIG_FRAME) }));
    await expect(c.run()).rejects.toThrow();
    expect(a.net.requests.length + b.net.requests.length + c.net.requests.length).toBe(0);
  });

  it("lets the consented appeal frame through, and only on the appeal frame path", async () => {
    const ok = post(
      APPEAL_FRAME_PATH,
      JSON.stringify({ appealId: "a1", imageBase64: b64(FRAME_BYTES) }),
      { "content-type": "application/json" },
    );
    await ok.run();
    expect(ok.net.requests).toHaveLength(1);
    const other = post(
      "/api/appeals",
      JSON.stringify({ imageBase64: b64(BIG_FRAME) }),
    );
    await expect(other.run()).rejects.toThrow();
  });

  it("lets ordinary JSON through", async () => {
    const p = post("/api/tasks", JSON.stringify({ title: "Read a chapter" }));
    await p.run();
    expect(p.net.requests).toHaveLength(1);
  });
});
