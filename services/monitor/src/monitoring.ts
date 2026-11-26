import { randomUUID } from "node:crypto";
import {
  SETTINGS,
  type SettingKey,
  type EventEnvelope,
  type Locale,
  type MessageRef,
  type MonitoringProfileSchema,
  type ReasonTicketStateSchema,
} from "@my-wife/contracts";

type Profile = (typeof MonitoringProfileSchema)["_output"];
type TicketState = (typeof ReasonTicketStateSchema)["_output"];

const SECOND_MS = 1000;

/** One monitoring session; the server owns every timestamp (browser clock values are advisory). */
export interface MonitoringSession {
  id: string;
  userId: string;
  taskId: string | null;
  profile: Profile;
  deviceId: string;
  startedAt: string;
  endedAt: string | null;
  /** Server time of the last heartbeat; the session start counts as the first sign of life. */
  lastHeartbeatAt: string;
}

export interface ReasonTicket {
  id: string;
  userId: string;
  sessionId: string;
  signal: "heartbeat_lost";
  /** Stable key of the signal occurrence; one ticket per key. */
  signalRef: string;
  state: TicketState;
  /** Server time the gap started (the last sign of life). */
  occurredAt: string;
  createdAt: string;
}

/** An urgent message record. Delivery (web banner, chat) is a later issue (MW-036). */
export interface UrgentMessage {
  id: string;
  userId: string;
  ticketId: string;
  class: "urgent";
  message: MessageRef;
  locale: Locale;
  sourceService: "monitor";
  isWakeUp: false;
  createdAt: string;
  delivered: boolean;
}

/** Ports: Drizzle stores replace the in-memory ones without touching the logic below. */
export interface SessionStore {
  add(s: MonitoringSession): void;
  get(userId: string, id: string): MonitoringSession | undefined;
  activeForUser(userId: string): MonitoringSession | undefined;
  allActive(): MonitoringSession[];
}
export interface TicketStore {
  add(t: ReasonTicket): void;
  hasRef(signalRef: string): boolean;
  all(): ReasonTicket[];
}
export interface UrgentStore {
  add(m: UrgentMessage): void;
  all(): UrgentMessage[];
}

export function createMemorySessionStore(): SessionStore {
  const sessions = new Map<string, MonitoringSession>();
  return {
    add: (s) => void sessions.set(s.id, s),
    get: (userId, id) => {
      const s = sessions.get(id);
      return s && s.userId === userId ? s : undefined;
    },
    activeForUser: (userId) =>
      [...sessions.values()].find((s) => s.userId === userId && s.endedAt === null),
    allActive: () => [...sessions.values()].filter((s) => s.endedAt === null),
  };
}
export function createMemoryTicketStore(): TicketStore {
  const tickets: ReasonTicket[] = [];
  return {
    add: (t) => void tickets.push(t),
    hasRef: (ref) => tickets.some((t) => t.signalRef === ref),
    all: () => [...tickets],
  };
}
export function createMemoryUrgentStore(): UrgentStore {
  const messages: UrgentMessage[] = [];
  return { add: (m) => void messages.push(m), all: () => [...messages] };
}

export interface MonitorState {
  sessions: SessionStore;
  tickets: TicketStore;
  urgent: UrgentStore;
}

export interface MonitorDeps {
  state: MonitorState;
  /** Clock for request handlers only; the gap check takes `now` as a parameter. */
  now: () => Date;
  publish: (event: EventEnvelope) => void | Promise<void>;
  /** Reads the user's settings; every answer falls back to its registry default. */
  readSettings: (userId: string) => Promise<Partial<Record<SettingKey, unknown>>>;
  locale: Locale;
}

function envelope(
  now: Date,
  id: string,
  type: string,
  userId: string,
  payload: unknown,
): EventEnvelope {
  return {
    id,
    type,
    occurredAt: now.toISOString(),
    userId,
    schemaVersion: 1,
    payload,
  } as EventEnvelope;
}

export type StartResult =
  { ok: true; session: MonitoringSession } | { ok: false; error: "session.already_active" };

/** Only one session per user is active; a second device is refused. */
export async function startMonitoring(
  deps: MonitorDeps,
  userId: string,
  input: { taskId: string | null; profile: Profile; deviceId: string },
): Promise<StartResult> {
  if (deps.state.sessions.activeForUser(userId)) {
    return { ok: false, error: "session.already_active" };
  }
  const now = deps.now();
  const session: MonitoringSession = {
    id: randomUUID(),
    userId,
    taskId: input.taskId,
    profile: input.profile,
    deviceId: input.deviceId,
    startedAt: now.toISOString(),
    endedAt: null,
    lastHeartbeatAt: now.toISOString(),
  };
  deps.state.sessions.add(session);
  await deps.publish(
    envelope(now, `monitor-session-started-${session.id}`, "monitor.session_started", userId, {
      sessionId: session.id,
      taskId: input.taskId,
    }),
  );
  return { ok: true, session };
}

/** Records a sign of life at the server time; the browser's `sentAt` is never used. */
export function recordHeartbeat(
  deps: MonitorDeps,
  userId: string,
  sessionId: string,
): "ok" | "not_found" | "ended" {
  const s = deps.state.sessions.get(userId, sessionId);
  if (!s) return "not_found";
  if (s.endedAt !== null) return "ended";
  s.lastHeartbeatAt = deps.now().toISOString();
  return "ok";
}

export async function endMonitoring(
  deps: MonitorDeps,
  userId: string,
  sessionId: string,
): Promise<MonitoringSession | undefined> {
  const s = deps.state.sessions.get(userId, sessionId);
  if (!s) return undefined;
  if (s.endedAt === null) {
    const now = deps.now();
    s.endedAt = now.toISOString();
    await deps.publish(
      envelope(now, `monitor-session-ended-${s.id}`, "monitor.session_ended", userId, {
        sessionId: s.id,
        endedAt: s.endedAt,
      }),
    );
  }
  return s;
}

async function gapSeconds(deps: MonitorDeps, userId: string): Promise<number> {
  const answer = (await deps.readSettings(userId))["monitor.heartbeat_missing_seconds"];
  return typeof answer === "number" && Number.isInteger(answer) && answer > 0
    ? answer
    : SETTINGS["monitor.heartbeat_missing_seconds"].default;
}

/**
 * Idempotent job. For every active session with no heartbeat for the configured gap it opens one
 * reason ticket and stores one urgent message. It never emits `fault.detected`: that waits for the
 * silence delay (MW-036). `now` is a parameter; this code never reads the system clock.
 */
export async function runGapCheck(
  deps: MonitorDeps,
  now: Date,
): Promise<{ tickets: string[]; failed: string[] }> {
  const result = { tickets: [] as string[], failed: [] as string[] };
  for (const s of deps.state.sessions.allActive()) {
    try {
      const seconds = await gapSeconds(deps, s.userId);
      if (now.getTime() - Date.parse(s.lastHeartbeatAt) < seconds * SECOND_MS) continue;
      const signalRef = `heartbeat_lost-${s.id}-${s.lastHeartbeatAt}`;
      if (deps.state.tickets.hasRef(signalRef)) continue;
      const ticket: ReasonTicket = {
        id: randomUUID(),
        userId: s.userId,
        sessionId: s.id,
        signal: "heartbeat_lost",
        signalRef,
        state: "open",
        occurredAt: s.lastHeartbeatAt,
        createdAt: now.toISOString(),
      };
      deps.state.tickets.add(ticket);
      deps.state.urgent.add({
        id: randomUUID(),
        userId: s.userId,
        ticketId: ticket.id,
        class: "urgent",
        message: { key: "monitor.urgent.heartbeat_lost", params: { seconds } },
        locale: deps.locale,
        sourceService: "monitor",
        isWakeUp: false,
        createdAt: now.toISOString(),
        delivered: false,
      });
      result.tickets.push(ticket.id);
    } catch {
      result.failed.push(s.id);
    }
  }
  return result;
}
