import { describe, expect, it } from "vitest";
import { HeartbeatRequestSchema } from "@my-wife/contracts";
import {
  createCameraMonitor,
  detectWebgl,
  selectDelegate,
  type FrameAnalyzer,
  type HeartbeatSender,
} from "../lib/camera-monitor";
import type { Ticker } from "../lib/countdown";

const SESSION = "0190a0a0-0000-7000-8000-000000000001";

function harness(analyzer: FrameAnalyzer) {
  let now = Date.parse("2026-11-26T08:00:00.000Z");
  let cb: (() => void) | null = null;
  const ticker: Ticker = (fn) => {
    cb = fn;
    return () => void (cb = null);
  };
  const sent: string[] = [];
  const send: HeartbeatSender = async (body) => void sent.push(body);
  const frames: unknown[] = [];
  const monitor = createCameraMonitor({
    sessionId: SESSION,
    heartbeatEverySeconds: 10,
    clock: { now: () => now },
    ticker,
    grabFrame: () => {
      const f = { pixels: new Uint8Array([1, 2, 3]) };
      frames.push(f);
      return f;
    },
    analyzer,
    send,
  });
  return {
    monitor,
    sent,
    frames,
    advance(sec: number) {
      for (let i = 0; i < sec; i++) {
        now += 1000;
        cb?.();
      }
    },
  };
}

describe("selectDelegate", () => {
  it("uses the CPU delegate when WebGL is unavailable", () => {
    expect(selectDelegate({ webglAvailable: false })).toBe("CPU");
  });
  it("uses the GPU delegate only when WebGL exists and CPU is not forced", () => {
    expect(selectDelegate({ webglAvailable: true })).toBe("GPU");
    expect(selectDelegate({ webglAvailable: true, forced: "cpu" })).toBe("CPU");
  });
  it("detectWebgl is false when no context can be created", () => {
    expect(detectWebgl(() => ({ getContext: () => null }))).toBe(false);
    expect(
      detectWebgl(() => {
        throw new Error("no canvas");
      }),
    ).toBe(false);
    expect(detectWebgl(() => ({ getContext: () => ({}) }))).toBe(true);
  });
});

describe("createCameraMonitor", () => {
  it("sends strict heartbeats and no frame data", () => {
    const h = harness({ analyze: () => [] });
    h.monitor.start();
    h.advance(25);
    expect(h.frames.length).toBeGreaterThan(0);
    expect(h.sent.length).toBe(2);
    for (const body of h.sent) {
      expect(HeartbeatRequestSchema.safeParse(JSON.parse(body)).success).toBe(true);
      expect(body).not.toMatch(/pixels|base64|frame/i);
    }
  });

  it("forwards filtered events with timestamps and confidence only", () => {
    let emitted = false;
    const h = harness({
      analyze: () => {
        if (emitted) return [];
        emitted = true;
        return [{ type: "no_face", startedAt: "2026-11-26T08:00:03.000Z", confidence: 0.9 }];
      },
    });
    h.monitor.start();
    h.advance(10);
    const parsed = HeartbeatRequestSchema.parse(JSON.parse(h.sent[0]!));
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0]?.type).toBe("no_face");
  });

  it("keeps heartbeating while the tab is hidden and reports tab_away on return", () => {
    let now = Date.parse("2026-11-26T08:00:00.000Z");
    let tick: (() => void) | null = null;
    let visibility: (hidden: boolean) => void = () => undefined;
    const sent: string[] = [];
    let analyzed = 0;
    createCameraMonitor({
      sessionId: SESSION,
      heartbeatEverySeconds: 10,
      clock: { now: () => now },
      ticker: (fn) => ((tick = fn), () => undefined),
      onVisibility: (cb) => ((visibility = cb), () => undefined),
      grabFrame: () => ({}),
      analyzer: { analyze: () => (analyzed++, []) },
      send: async (b) => void sent.push(b),
    }).start();
    const advance = (s: number) => {
      for (let i = 0; i < s; i++) {
        now += 1000;
        tick?.();
      }
    };
    visibility(true);
    advance(20);
    expect(sent).toHaveLength(2);
    expect(analyzed).toBe(0);
    visibility(false);
    advance(10);
    const last = HeartbeatRequestSchema.parse(JSON.parse(sent[2]!));
    expect(last.events.map((e) => e.type)).toEqual(["tab_away"]);
  });

  it("stops sending after stop()", () => {
    const h = harness({ analyze: () => [] });
    h.monitor.start();
    h.monitor.stop();
    h.advance(30);
    expect(h.sent).toHaveLength(0);
  });
});
