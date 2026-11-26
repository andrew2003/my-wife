import { randomUUID } from "node:crypto";
import {
  SETTINGS,
  type SettingKey,
  type EventEnvelope,
  type Locale,
  type MessageRef,
  type OutboundMessage,
  type ReasonKindSchema,
  type MonitoringProfileSchema,
  type ReasonTicketStateSchema,
} from "@my-wife/contracts";

type Profile = (typeof MonitoringProfileSchema)["_output"];
type ReasonKind = (typeof ReasonKindSchema)["_output"];
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
  /** Set when the user answers (`reason.given`). */
  answeredAt?: string;
  reasonKind?: ReasonKind;
  reasonText?: string;
  /** Set when the chat message went out (state `escalated`). */
  escalatedAt?: string;
  /** Set when the silence delay passed (state `expired`). */
  expiredAt?: string;
}

/** An urgent message record. `delivered` is true once notify accepted it. */
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
  /** Server time notify accepted the first send; the minimum gap counts from it. */
  sentAt?: string;
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
  get(userId: string, id: string): ReasonTicket | undefined;
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
    get: (userId, id) => tickets.find((t) => t.id === id && t.userId === userId),
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
  /** Hands an urgent message to notify (`POST /messages`); throws when it was not accepted. */
  sendUrgent: (message: OutboundMessage) => Promise<void>;
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

type PositiveKey =
  | "monitor.heartbeat_missing_seconds"
  | "monitor.urgent_chat_after_seconds"
  | "monitor.urgent_silent_fault_after_seconds"
  | "monitor.urgent_min_gap_minutes";

/** A positive integer setting, or the registry default when the answer is missing or invalid. */
async function positiveSetting(
  deps: MonitorDeps,
  userId: string,
  key: PositiveKey,
): Promise<number> {
  const answer = (await deps.readSettings(userId))[key];
  return typeof answer === "number" && Number.isInteger(answer) && answer > 0
    ? answer
    : SETTINGS[key].default;
}
const gapSeconds = (deps: MonitorDeps, userId: string) =>
  positiveSetting(deps, userId, "monitor.heartbeat_missing_seconds");

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

export type GiveReasonResult =
  { ok: true; ticket: ReasonTicket } | { ok: false; error: "ticket.not_found" | "ticket.not_open" };

/** The user answers a ticket that is still `open` or `escalated`; a repeat or a late answer is refused. */
export async function giveReason(
  deps: MonitorDeps,
  userId: string,
  input: { ticketId: string; kind: ReasonKind; text?: string },
  now: Date,
): Promise<GiveReasonResult> {
  const t = deps.state.tickets.get(userId, input.ticketId);
  if (!t) return { ok: false, error: "ticket.not_found" };
  if (t.state !== "open" && t.state !== "escalated") return { ok: false, error: "ticket.not_open" };
  const previous = { ...t };
  t.state = "answered";
  t.answeredAt = now.toISOString();
  t.reasonKind = input.kind;
  if (input.text) t.reasonText = input.text;
  try {
    await deps.publish(
      envelope(now, `reason-given-${t.id}`, "reason.given", userId, {
        ticketId: t.id,
        signalRef: t.signalRef,
        kind: input.kind,
        givenAt: t.answeredAt,
      }),
    );
  } catch (err) {
    // The answer is not recorded unless it was announced; the user can answer again.
    Object.assign(t, previous);
    delete t.answeredAt;
    delete t.reasonKind;
    delete t.reasonText;
    throw err;
  }
  return { ok: true, ticket: t };
}

async function sendUrgentOnce(
  deps: MonitorDeps,
  msg: UrgentMessage,
  channel: "web" | "chat",
  now: Date,
): Promise<boolean> {
  try {
    await deps.sendUrgent({
      id: msg.id,
      class: "urgent",
      message: msg.message,
      locale: msg.locale,
      sourceService: "monitor",
      isWakeUp: false,
      createdAt: msg.createdAt,
    });
  } catch {
    return false;
  }
  // Announce first: if this throws the message stays undelivered and the next run resends
  // (same message id, same event id) instead of losing `urgent.sent`.
  await deps.publish(
    envelope(now, `urgent-sent-${msg.ticketId}-${channel}`, "urgent.sent", msg.userId, {
      ticketId: msg.ticketId,
      channel,
    }),
  );
  msg.delivered = true;
  msg.sentAt ??= now.toISOString();
  return true;
}

/**
 * Idempotent escalation job: (1) the first urgent message goes through notify (web banner) unless
 * another one went out within `monitor.urgent_min_gap_minutes`; (2) after the chat delay the same
 * message is sent as a chat message and the ticket is `escalated`; (3) after the silence delay the
 * ticket is `expired`, `reason.expired` and `fault.detected` (reason none) are emitted, but only
 * for a ticket whose urgent message was delivered. The chat delay counts from the ticket creation,
 * the silence delay from the delivered first send. State changes after the events are published. `now` is a parameter.
 */
export async function runUrgentJob(deps: MonitorDeps, now: Date): Promise<{ failed: string[] }> {
  const failed: string[] = [];
  const lastSent = new Map<string, number>();
  for (const m of deps.state.urgent.all()) {
    if (m.delivered) {
      const at = Date.parse(m.sentAt ?? m.createdAt);
      lastSent.set(m.userId, Math.max(lastSent.get(m.userId) ?? 0, at));
    }
  }
  for (const t of deps.state.tickets.all()) {
    if (t.state !== "open" && t.state !== "escalated") continue;
    try {
      const msg = deps.state.urgent.all().find((m) => m.ticketId === t.id);
      const age = now.getTime() - Date.parse(t.createdAt);
      const silent = await positiveSetting(
        deps,
        t.userId,
        "monitor.urgent_silent_fault_after_seconds",
      );
      if (
        msg?.delivered &&
        now.getTime() - Date.parse(msg.sentAt ?? msg.createdAt) >= silent * SECOND_MS
      ) {
        await deps.publish(
          envelope(now, `reason-expired-${t.id}`, "reason.expired", t.userId, {
            ticketId: t.id,
            signalRef: t.signalRef,
          }),
        );
        await deps.publish(
          envelope(now, `fault-detected-${t.signalRef}`, "fault.detected", t.userId, {
            signalRef: t.signalRef,
            type: t.signal,
            occurredAt: t.occurredAt,
            reason: "none",
            reasonRef: null,
            reasonKind: null,
            overlapsOutage: false,
          }),
        );
        t.state = "expired";
        t.expiredAt = now.toISOString();
        continue;
      }
      if (!msg) continue;
      if (!msg.delivered) {
        const minGap = await positiveSetting(deps, t.userId, "monitor.urgent_min_gap_minutes");
        const prev = lastSent.get(t.userId);
        if (prev !== undefined && now.getTime() - prev < minGap * 60 * SECOND_MS) continue;
        if (await sendUrgentOnce(deps, msg, "web", now)) {
          lastSent.set(t.userId, now.getTime());
        } else failed.push(t.id);
        continue;
      }
      const chatAfter = await positiveSetting(deps, t.userId, "monitor.urgent_chat_after_seconds");
      if (t.state === "open" && age >= chatAfter * SECOND_MS) {
        if (await sendUrgentOnce(deps, msg, "chat", now)) {
          t.state = "escalated";
          t.escalatedAt = now.toISOString();
        } else failed.push(t.id);
      }
    } catch {
      failed.push(t.id);
    }
  }
  return { failed };
}
