/** Time source; tests inject a fake one so no real waiting is needed. */
export interface Clock {
  now(): number;
}

/** Calls `fn` about once a second until the returned stop function is called. */
export type Ticker = (fn: () => void) => () => void;

export const systemClock: Clock = { now: () => Date.now() };

/** Remaining whole seconds: end minus now, rounded up, never negative. Never accumulates ticks. */
export function remainingSeconds(endsAtMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((endsAtMs - nowMs) / 1000));
}

const pad = (n: number) => String(n).padStart(2, "0");

export function formatRemaining(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/**
 * Real ticker: the interval runs in a Web Worker so a background tab does not throttle it.
 * Falls back to a page timer where Workers are unavailable.
 */
export const workerTicker: Ticker = (fn) => {
  if (typeof Worker !== "undefined" && typeof Blob !== "undefined" && typeof URL !== "undefined") {
    try {
      const url = URL.createObjectURL(
        new Blob(["setInterval(() => postMessage(0), 1000);"], { type: "text/javascript" }),
      );
      const worker = new Worker(url);
      worker.onmessage = () => fn();
      return () => {
        worker.terminate();
        URL.revokeObjectURL(url);
      };
    } catch {
      // fall through to the page timer
    }
  }
  const id = setInterval(fn, 1000);
  return () => clearInterval(id);
};

export interface CountdownOptions {
  /** Stored end time (UTC ms) from the server. */
  endsAtMs: number;
  clock?: Clock;
  ticker?: Ticker;
  /** Server time minus client time, measured when the session was fetched. */
  serverOffsetMs?: number;
  onTick: (remainingSeconds: number) => void;
  /** Called once when the remaining time reaches zero. */
  onEnd?: () => void;
}

/** Computes the display from the end time on every tick, so a late or missed tick never drifts. */
export function createCountdown(opts: CountdownOptions): { stop: () => void } {
  const clock = opts.clock ?? systemClock;
  const offset = opts.serverOffsetMs ?? 0;
  let ended = false;
  let stopTicker: (() => void) | null = null;
  const refresh = () => {
    const left = remainingSeconds(opts.endsAtMs, clock.now() + offset);
    opts.onTick(left);
    if (left === 0 && !ended) {
      ended = true;
      stopTicker?.();
      opts.onEnd?.();
    }
  };
  stopTicker = (opts.ticker ?? workerTicker)(refresh);
  refresh();
  return { stop: () => stopTicker?.() };
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ActiveSession {
  id: string;
  endsAtMs: number;
  serverOffsetMs: number;
}

/** Loads the running session of a task (reload path). Null when none or on any failure. */
export async function loadActiveSession(
  taskId: string,
  clock: Clock = systemClock,
  doFetch: FetchLike = fetch,
): Promise<ActiveSession | null> {
  try {
    const before = clock.now();
    const res = await doFetch(`/api/sessions/active?taskId=${encodeURIComponent(taskId)}`, {
      cache: "no-store",
    });
    const body = (await res.json()) as {
      ok?: boolean;
      data?: { session?: { id: string; plannedEndAt: string; serverNow: string } };
    };
    const s = body.data?.session;
    if (!res.ok || !body.ok || !s) return null;
    const mid = (before + clock.now()) / 2;
    return {
      id: s.id,
      endsAtMs: Date.parse(s.plannedEndAt),
      serverOffsetMs: Date.parse(s.serverNow) - mid,
    };
  } catch {
    return null;
  }
}
