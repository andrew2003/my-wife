import { loadConfig } from "@my-wife/config";
import type { EventEnvelope, OutboundMessage } from "@my-wife/contracts";
import { SimClock } from "@my-wife/test-kit";
import type { MonitorDeps, MonitorState } from "../../../services/monitor/src/monitoring";
import {
  createMemoryBreakStore,
  createMemoryHeartbeatStore,
  createMemoryNudgeStore,
  createMemorySessionStore,
  createMemoryTicketStore,
  createMemoryUrgentStore,
  createMemoryWaiverStore,
} from "../../../services/monitor/src/monitoring";
import {
  answerTaper,
  createMemorySupervisionStore,
  trackSpecialMode,
} from "../../../services/monitor/src/tapering";
// The dev runner exports no package entry point; the scenario mounts it from its sources.
import { mountGapCheckJob, mountSessionJob, startAll } from "../../dev-runner/src/runner";

export const TIME_USER = "0190a0a0-0000-7000-8000-0000000000f3";
const SECOND_MS = 1000;
const MINUTE_MS = 60_000;

/**
 * The schedule, monitor and rules services of the time flow in one process through the dev
 * runner, on one `SimClock`. Every job receives `now` from the simulator. The fake camera is a
 * heartbeat source on the clock: while it is on, a heartbeat goes to the monitor every 10 s (the
 * registry default of `monitor.heartbeat_interval_seconds`); turning it off is a lost camera.
 * Chat is emulated: urgent messages handed to notify are collected, not delivered.
 *
 * The dev runner does not route `fault.detected` (monitor to rules) nor `fault.recorded`
 * (rules to the schedule ledger), so this file bridges them the way the bus would.
 */
export async function startTimeWorld(opts: {
  start: string;
  /** Settings every service reads (schedule and monitor); anything missing is the registry default. */
  settings?: Record<string, unknown>;
  /** Also run the day-end (carry-over) and special-mode jobs on the clock, hourly. */
  extended?: boolean;
}) {
  const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
  const clock = new SimClock(opts.start);
  const now = () => clock.now();
  const events: EventEnvelope[] = [];
  const urgentMessages: OutboundMessage[] = [];
  let cameraOn = false;
  let monitorSessionId: string | undefined;

  const headers = { "content-type": "application/json", "x-user-id": TIME_USER };
  const post = (url: string, payload?: unknown) =>
    fetch(url, { method: "POST", headers, body: JSON.stringify(payload ?? {}) });
  const get = (url: string) => fetch(url, { headers });

  const settings = opts.settings ?? {};
  const readSettings = async () => settings;
  // The monitor stores are shared with the tapering consumers below, which the dev runner does not route.
  const monitorState: MonitorState = {
    heartbeats: createMemoryHeartbeatStore(),
    waivers: createMemoryWaiverStore(),
    breaks: createMemoryBreakStore(),
    nudges: createMemoryNudgeStore(),
    sessions: createMemorySessionStore(),
    tickets: createMemoryTicketStore(),
    urgent: createMemoryUrgentStore(),
    supervision: createMemorySupervisionStore(),
  };
  const monitorDeps = (): MonitorDeps => ({
    state: monitorState,
    now,
    publish: (e) => void events.push(e),
    readSettings,
    locale: "en",
    listOutages: async () => [],
    sendUrgent: async () => undefined,
  });

  const runner = await startAll(config, {
    ephemeralPorts: true,
    schedule: {
      now,
      readSettings,
      publish: async (e) => {
        events.push(e);
        // Bus bridges the dev runner does not have: week.closed to monitor, special_mode.* to monitor.
        if (e.type === "week.closed") await post(`${runner.urls.monitor}/events/week-closed`, e);
        if (e.type === "special_mode.started" || e.type === "special_mode.ended")
          await trackSpecialMode(monitorDeps(), e);
      },
    },
    monitor: {
      now,
      readSettings,
      state: monitorState,
      publish: async (e) => {
        events.push(e);
        if (e.type === "fault.detected")
          await post(`${runner.urls.rules}/events/fault-detected`, e);
      },
      sendUrgent: async (m) => void urgentMessages.push(m),
    },
    rules: {
      now,
      publish: async (e) => {
        events.push(e);
        if (e.type === "fault.recorded") await post(`${runner.urls.schedule}/events/ledger`, e);
      },
    },
  });
  const urls = runner.urls;

  mountSessionJob(runner, clock, MINUTE_MS);
  // The monitor jobs tick every 5 s. A scenario that spans weeks switches them off between
  // monitoring runs (`disarmMonitorJobs`) so idle days cost no ticks; `startMonitoring` arms them.
  let monitorTimers: number[] = [];
  const armMonitorJobs = () => {
    if (monitorTimers.length > 0) return;
    monitorTimers = [
      mountGapCheckJob(runner, clock, 5 * SECOND_MS),
      clock.scheduleEvery(
        5 * SECOND_MS,
        async () => void (await post(`${urls.monitor}/jobs/urgent`)),
      ),
    ];
  };
  const disarmMonitorJobs = () => {
    for (const id of monitorTimers) clock.cancel(id);
    monitorTimers = [];
  };
  armMonitorJobs();
  clock.scheduleEvery(
    60 * MINUTE_MS,
    async () => void (await post(`${urls.schedule}/jobs/week-boundary`)),
  );
  if (opts.extended) {
    clock.scheduleEvery(
      60 * MINUTE_MS,
      async () => void (await post(`${urls.schedule}/jobs/day-end`)),
    );
    clock.scheduleEvery(
      60 * MINUTE_MS,
      async () => void (await post(`${urls.schedule}/jobs/special-modes`)),
    );
  }
  // The fake camera: a heartbeat every 10 s while it is on. `sentAt` is advisory only.
  clock.scheduleEvery(10 * SECOND_MS, async () => {
    if (!cameraOn || !monitorSessionId) return;
    await post(`${urls.monitor}/heartbeat`, {
      sessionId: monitorSessionId,
      sentAt: now().toISOString(),
      events: [],
    });
  });

  return {
    clock,
    events,
    urgentMessages,
    urls,
    types: () => events.map((e) => e.type),
    ofType: <T extends EventEnvelope["type"]>(type: T) =>
      events.filter((e) => e.type === type) as EventEnvelope<T>[],
    post,
    get,
    /** Starts monitoring with the camera profile and switches the fake camera on. */
    startMonitoring: async (taskId: string | null) => {
      armMonitorJobs();
      const res = await post(`${urls.monitor}/sessions/start`, {
        taskId,
        profile: "camera",
        deviceId: "e2e-fake-camera",
      });
      const body = (await res.json()) as { ok: boolean; data?: { sessionId: string } };
      if (body.data) {
        monitorSessionId = body.data.sessionId;
        cameraOn = true;
      }
      return { status: res.status, sessionId: body.data?.sessionId };
    },
    /** The user's answer to a question the monitor asked (stands in for notify's reply event). */
    reply: (questionId: string, kind: string, value: string) =>
      answerTaper(monitorDeps(), {
        id: `reply-${questionId}`,
        type: "notify.reply_received",
        occurredAt: now().toISOString(),
        userId: TIME_USER,
        schemaVersion: 1,
        payload: {
          questionId,
          sourceService: "monitor",
          kind,
          value,
          answeredAt: now().toISOString(),
          via: "chat",
        },
      } as EventEnvelope),
    supervision: () => monitorState.supervision.get(TIME_USER),
    disarmMonitorJobs,
    setCamera: (on: boolean) => {
      cameraOn = on;
    },
    stop: () => runner.stop(),
  };
}

export type TimeWorld = Awaited<ReturnType<typeof startTimeWorld>>;
