import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { HeartbeatRequestSchema } from "@my-wife/contracts";
import en from "../locales/en.json";
import vi_ from "../locales/vi.json";
import { FocusSessionView } from "../components/focus-session-view";
import {
  countSince,
  finishEarly,
  leaveWithReason,
  loadFocusSession,
  pauseSession,
  pomodoroPercent,
  resumeSession,
  ringFraction,
  urgentSecondsLeft,
  type FocusSession,
} from "../lib/focus-session";
import { createCameraMonitor, httpHeartbeatSender } from "../lib/camera-monitor";
import { createFrameGuardedFetch } from "../lib/frame-guard";
import { createCountdown } from "../lib/countdown";

const SID = "0190a0a0-0000-7000-8000-000000000001";
const START = Date.parse("2026-11-28T08:00:00.000Z");
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const sessionBody = (serverNowMs: number) => ({
  ok: true,
  data: {
    session: {
      id: SID,
      taskId: "0190a0a0-0000-7000-8000-000000000002",
      startedAt: new Date(START).toISOString(),
      durationMinutes: 25,
      endedAt: null,
      plannedEndAt: new Date(START + 25 * 60_000).toISOString(),
      serverNow: new Date(serverNowMs).toISOString(),
      phase: "work",
      monitoringPaused: false,
      break: {
        kind: "short",
        startedAt: new Date(START + 25 * 60_000).toISOString(),
        endsAt: new Date(START + 30 * 60_000).toISOString(),
        remainingSeconds: 300,
      },
    },
  },
});

const SESSION: FocusSession = {
  id: SID,
  startedAtMs: START,
  endsAtMs: START + 25 * 60_000,
  durationMinutes: 25,
  phase: "work",
  breakMinutes: 5,
  serverOffsetMs: 0,
};

describe("ring and pomodoro maths", () => {
  it("ring fraction follows the server time, not the device time", () => {
    expect(ringFraction(SESSION, START)).toBe(1);
    expect(ringFraction(SESSION, START + 12.5 * 60_000)).toBeCloseTo(0.5);
    expect(ringFraction(SESSION, START + 99 * 60_000)).toBe(0);
    expect(ringFraction({ ...SESSION, endsAtMs: START }, START)).toBe(0);
  });
  it("pomodoro progress is the elapsed share of the work phase", () => {
    expect(pomodoroPercent(SESSION, START + 5 * 60_000)).toBe(20);
    expect(pomodoroPercent(SESSION, START - 1000)).toBe(0);
    expect(pomodoroPercent(SESSION, START + 60 * 60_000)).toBe(100);
  });
  it("urgent seconds left counts down to the answer deadline and stops at zero", () => {
    expect(urgentSecondsLeft(START + 60_000, START)).toBe(60);
    expect(urgentSecondsLeft(START, START + 5000)).toBe(0);
  });
  it("counts only items inside the session", () => {
    const at = (ms: number) => ({ occurredAt: new Date(ms).toISOString() });
    expect(countSince([at(START - 1), at(START), at(START + 5)], START)).toBe(2);
  });
});

describe("loading the session", () => {
  it("measures the server offset from the response clock", async () => {
    let t = START;
    const clock = { now: () => t };
    const doFetch = vi.fn(async () => {
      t += 200;
      return json(200, sessionBody(START + 5000));
    });
    const s = await loadFocusSession(SID, clock, doFetch);
    expect(doFetch).toHaveBeenCalledWith(`/api/sessions/${SID}`, { cache: "no-store" });
    expect(s?.endsAtMs).toBe(START + 25 * 60_000);
    expect(s?.breakMinutes).toBe(5);
    // the server is 5000 ms ahead of the device mid-point (START + 100)
    expect(s?.serverOffsetMs).toBe(4900);
  });
  it("is null on failure or a bad body", async () => {
    expect(await loadFocusSession(SID, undefined, async () => json(404, { ok: false }))).toBeNull();
    expect(await loadFocusSession(SID, undefined, async () => json(200, { ok: true }))).toBeNull();
    expect(
      await loadFocusSession(SID, undefined, async () => {
        throw new Error("offline");
      }),
    ).toBeNull();
  });
});

describe("session actions", () => {
  const ok = () => json(200, { ok: true, data: {} });
  it("pause and resume use the break endpoints with the session id", async () => {
    const f = vi.fn(async (_u: string, _i?: RequestInit) => ok());
    expect(await pauseSession(SID, f)).toBe(true);
    expect(await resumeSession(SID, f)).toBe(true);
    const calls = f.mock.calls;
    expect(calls.map((c) => c[0])).toEqual([
      "/api/monitor/breaks/start",
      "/api/monitor/breaks/end",
    ]);
    expect(JSON.parse(String(calls[0]![1]?.body))).toEqual({ sessionId: SID });
  });
  it("a refused pause (quota) reports false", async () => {
    expect(await pauseSession(SID, async () => json(409, { ok: false }))).toBe(false);
  });
  it("finish early stops the work session and the monitoring session", async () => {
    const f = vi.fn(async (_u: string, _i?: RequestInit) => ok());
    expect(await finishEarly(SID, f)).toBe(true);
    expect(f.mock.calls.map((c) => c[0])).toEqual([
      `/api/sessions/${SID}/stop`,
      `/api/monitor/sessions/${SID}/end`,
    ]);
  });
  it("leave sends the reason first when a ticket is open, then ends", async () => {
    const f = vi.fn(async (_u: string, _i?: RequestInit) => ok());
    const TICKET = "0190a0a0-0000-7000-8000-0000000000aa";
    expect(await leaveWithReason(SID, { kind: "restroom", ticketId: TICKET }, f)).toBe(true);
    const calls = f.mock.calls;
    expect(calls[0]![0]).toBe("/api/monitor/reasons");
    expect(JSON.parse(String(calls[0]![1]?.body))).toEqual({ ticketId: TICKET, kind: "restroom" });
    expect(calls).toHaveLength(3);
  });
  it("leave without a ticket just ends the session", async () => {
    const f = vi.fn(async (_u: string, _i?: RequestInit) => ok());
    await leaveWithReason(SID, { kind: "water", ticketId: null }, f);
    expect(f).toHaveBeenCalledTimes(2);
  });
});

const baseProps = {
  locale: "en" as const,
  session: SESSION,
  remainingSeconds: 750,
  fraction: 0.5,
  pomodoroPercent: 50,
  distractions: 2,
  faults: 1,
  paused: false,
  urgent: null,
  camera: createElement("div", { "data-testid": "camera-slot" }),
  extras: createElement("div", { "data-testid": "extras-slot" }),
  onPause: () => {},
  onResume: () => {},
  onFinish: () => {},
  onLeave: () => {},
  onFullscreen: () => {},
  onReason: () => {},
};
const render = (over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(FocusSessionView, { ...baseProps, ...over }));

describe("FocusSessionView", () => {
  it("shows the ring, the timer, counts, the privacy note and the camera panel", () => {
    const html = render();
    expect(html).toContain('role="timer"');
    expect(html).toContain("12:30");
    expect(html).toContain(en["focus.privacy"]);
    expect(html).toContain('data-testid="camera-slot"');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain("stroke-dashoffset");
    expect(html).toContain(en["focus.distractions"]);
    expect(html).toContain(en["focus.faults"]);
  });
  it("renders in Vietnamese", () => {
    expect(render({ locale: "vi" })).toContain(vi_["focus.privacy"]);
  });
  it("offers pause, finish early and leave; resume replaces pause while paused", () => {
    const html = render();
    expect(html).toContain(en["focus.pause"]);
    expect(html).toContain(en["focus.finish"]);
    expect(html).toContain(en["focus.leave"]);
    expect(html).toContain(en["focus.fullscreen"]);
    const paused = render({ paused: true });
    expect(paused).toContain(en["focus.resume"]);
    expect(paused).not.toContain(`>${en["focus.pause"]}<`);
  });
  it("shows the urgent prompt with the deadline and the reason buttons", () => {
    const html = render({ urgent: { ticketId: "t", secondsLeft: 45 } });
    expect(html).toContain('role="alert"');
    expect(html).toContain("00:45");
    expect(html).toContain(en["focus.reason.restroom"]);
    expect(render()).not.toContain('role="alert"');
  });
  it("labels the break phase", () => {
    expect(render({ session: { ...SESSION, phase: "break" } })).toContain(en["focus.phase.break"]);
  });
  it("never renders a video or an image outside the camera slot", () => {
    expect(render()).not.toMatch(/<img|<video|<canvas/);
  });
});

describe("hidden tab", () => {
  it("the countdown shows the right number after a hidden period", () => {
    let now = START;
    let tick: () => void = () => {};
    let onVisible: () => void = () => {};
    const seen: number[] = [];
    createCountdown({
      endsAtMs: START + 600_000,
      clock: { now: () => now },
      ticker: (fn) => ((tick = fn), () => {}),
      visibility: { subscribe: (cb) => ((onVisible = cb), () => {}) },
      onTick: (s) => seen.push(s),
    });
    now += 300_000;
    onVisible();
    expect(seen.at(-1)).toBe(300);
    now += 1000;
    tick();
    expect(seen.at(-1)).toBe(299);
  });
  it("heartbeats keep leaving from the ticker while the tab is hidden, then report tab_away", () => {
    let now = START;
    let tick: () => void = () => {};
    let hide: (h: boolean) => void = () => {};
    const sent: string[] = [];
    const m = createCameraMonitor({
      sessionId: SID,
      heartbeatEverySeconds: 10,
      clock: { now: () => now },
      ticker: (fn) => ((tick = fn), () => {}),
      onVisibility: (cb) => ((hide = cb), () => {}),
      grabFrame: () => ({ data: new Uint8Array(4) }),
      analyzer: { analyze: () => [] },
      send: async (b) => void sent.push(b),
    });
    m.start();
    hide(true);
    for (let i = 0; i < 25; i++) {
      now += 1000;
      tick();
    }
    expect(sent.length).toBe(2);
    hide(false);
    now += 10_000;
    tick();
    const events = sent.flatMap((b) => HeartbeatRequestSchema.parse(JSON.parse(b)).events);
    expect(sent.length).toBe(3);
    expect(events.some((e) => e.type === "tab_away")).toBe(true);
  });
});

describe("video never leaves the device", () => {
  it("a fake-camera run through the guarded sender sends JSON heartbeats only", async () => {
    const requests: { url: string; body: unknown }[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      requests.push({ url, body: init?.body });
      return new Response("{}");
    }) as unknown as typeof fetch;
    let now = START;
    let tick: () => void = () => {};
    const frame = new Uint8Array(4096).map((_, i) => (i * 7) % 256);
    const m = createCameraMonitor({
      sessionId: SID,
      heartbeatEverySeconds: 5,
      clock: { now: () => now },
      ticker: (fn) => ((tick = fn), () => {}),
      grabFrame: () => ({ data: frame }),
      analyzer: { analyze: () => [] },
      send: httpHeartbeatSender(createFrameGuardedFetch(fakeFetch)),
    });
    m.start();
    for (let i = 0; i < 20; i++) {
      now += 1000;
      tick();
    }
    await Promise.resolve();
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) {
      expect(r.url).toBe("/api/monitor/heartbeat");
      expect(typeof r.body).toBe("string");
    }
  });
  it("the screen sources never record, encode or upload camera data", () => {
    for (const f of [
      "../components/focus-session-screen.tsx",
      "../components/focus-session-view.tsx",
      "../lib/focus-session.ts",
    ]) {
      const src = readFileSync(new URL(f, import.meta.url), "utf8");
      expect(src).not.toMatch(/MediaRecorder|toDataURL|toBlob|captureStream|FormData/);
    }
  });
});

describe("locale catalogs", () => {
  it("both catalogs define every focus key; the privacy note says nothing is stored", () => {
    const keys = Object.keys(en).filter((k) => k.startsWith("focus."));
    expect(keys.length).toBeGreaterThan(15);
    for (const k of keys) expect(Object.keys(vi_)).toContain(k);
    expect(en["focus.privacy"]).toMatch(/device/i);
    expect(en["focus.privacy"]).toMatch(/stored/i);
  });
});
