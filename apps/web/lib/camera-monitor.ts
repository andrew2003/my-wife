import { HeartbeatRequestSchema, type Signal } from "@my-wife/contracts";
import { systemClock, workerTicker, type Clock, type Ticker } from "./countdown";

/**
 * Focus monitoring in the browser (spec 21, principle 5). Frames are analysed here and never
 * leave this module: the only thing sent to the server is a heartbeat with filtered events.
 */

export type Delegate = "CPU" | "GPU";

/** CPU unless WebGL exists; `forced: "cpu"` (CAMERA_ANALYSIS_DELEGATE) always wins. */
export function selectDelegate(opts: { webglAvailable: boolean; forced?: string }): Delegate {
  if (opts.forced?.toLowerCase() === "cpu") return "CPU";
  return opts.webglAvailable ? "GPU" : "CPU";
}

/** True when a WebGL context can be created. `makeCanvas` is injectable for tests. */
export function detectWebgl(
  makeCanvas: () => { getContext: (id: string) => unknown } = () =>
    document.createElement("canvas"),
): boolean {
  try {
    const canvas = makeCanvas();
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

/** A filtered result of analysis: type, timestamps and confidence. Never pixels. */
export interface DetectedEvent {
  type: Signal;
  startedAt: string;
  endedAt?: string;
  confidence: number;
}

/** Local frame analyser (MediaPipe in production). Frames stay inside it. */
export interface FrameAnalyzer {
  analyze(frame: unknown, atMs: number): DetectedEvent[];
}

export type HeartbeatSender = (jsonBody: string) => Promise<unknown>;

export interface CameraMonitorOptions {
  sessionId: string;
  /** `monitor.heartbeat_interval_seconds`. */
  heartbeatEverySeconds: number;
  grabFrame: () => unknown;
  analyzer: FrameAnalyzer;
  send: HeartbeatSender;
  clock?: Clock;
  /** Runs in a Web Worker by default so a hidden tab keeps beating. */
  ticker?: Ticker;
  /** Subscribe to tab visibility changes; returns an unsubscribe function. */
  onVisibility?: (cb: (hidden: boolean) => void) => () => void;
}

export function createCameraMonitor(opts: CameraMonitorOptions): { start: () => void; stop: () => void } {
  const clock = opts.clock ?? systemClock;
  const ticker = opts.ticker ?? workerTicker;
  let stopTicker: (() => void) | null = null;
  let stopVisibility: (() => void) | null = null;
  let pending: DetectedEvent[] = [];
  let lastSentMs = 0;
  let hiddenSinceMs: number | null = null;

  const iso = (ms: number) => new Date(ms).toISOString();

  const flush = (nowMs: number) => {
    lastSentMs = nowMs;
    const body = HeartbeatRequestSchema.parse({
      sessionId: opts.sessionId,
      sentAt: iso(nowMs),
      events: pending,
    });
    pending = [];
    // Fire and forget: a failed send is simply followed by the next heartbeat.
    void opts.send(JSON.stringify(body)).catch(() => undefined);
  };

  const tick = () => {
    const nowMs = clock.now();
    // A hidden tab cannot be analysed; the heartbeat still goes out from the worker timer.
    if (hiddenSinceMs === null) {
      pending.push(...opts.analyzer.analyze(opts.grabFrame(), nowMs));
    }
    if (nowMs - lastSentMs >= opts.heartbeatEverySeconds * 1000) flush(nowMs);
  };

  return {
    start() {
      lastSentMs = clock.now();
      stopVisibility =
        opts.onVisibility?.((hidden) => {
          const nowMs = clock.now();
          if (hidden) {
            hiddenSinceMs = nowMs;
          } else if (hiddenSinceMs !== null) {
            pending.push({
              type: "tab_away",
              startedAt: iso(hiddenSinceMs),
              endedAt: iso(nowMs),
              confidence: 1,
            });
            hiddenSinceMs = null;
          }
        }) ?? null;
      stopTicker = ticker(tick);
    },
    stop() {
      stopTicker?.();
      stopVisibility?.();
      stopTicker = null;
      stopVisibility = null;
    },
  };
}

/** Real sender: strict JSON to the gateway. The body is a string, never an image or binary. */
export function httpHeartbeatSender(doFetch: typeof fetch = fetch): HeartbeatSender {
  return (jsonBody) =>
    doFetch("/api/monitor/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: jsonBody,
    });
}

export function documentVisibility(cb: (hidden: boolean) => void): () => void {
  const handler = () => cb(document.visibilityState === "hidden");
  document.addEventListener("visibilitychange", handler);
  return () => document.removeEventListener("visibilitychange", handler);
}
