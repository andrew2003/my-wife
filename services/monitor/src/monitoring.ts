import { randomUUID } from "node:crypto";
import {
  SETTINGS,
  SoftSignalSchema,
  type FocusEventSchema,
  type SettingKey,
  type EventEnvelope,
  type Locale,
  type MessageRef,
  type OutboundMessage,
  type ReasonKindSchema,
  type MonitoringProfileSchema,
  type ReasonTicketStateSchema,
} from "@my-wife/contracts";
import { decideReasonOutcome, localWeekStart } from "./reason-quota";

type Profile = (typeof MonitoringProfileSchema)["_output"];
type ReasonKind = (typeof ReasonKindSchema)["_output"];
type SoftSignal = (typeof SoftSignalSchema)["_output"];
type FocusEvent = (typeof FocusEventSchema)["_output"];
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
  /** How the answer is scored: an honest reason, or silence (quota used up). Set with the answer. */
  scoredAs?: "honest" | "silence";
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

/** A nudge given for a soft signal. It is a hint only: no ticket, no fault, no urgent message. */
export interface Nudge {
  /** Stable key of the signal occurrence; one nudge per key. */
  signalRef: string;
  userId: string;
  sessionId: string;
  signal: SoftSignal;
  messageKey: string;
  createdAt: string;
}
export interface NudgeStore {
  add(n: Nudge): void;
  hasRef(signalRef: string): boolean;
  all(): Nudge[];
}
export function createMemoryNudgeStore(): NudgeStore {
  const nudges: Nudge[] = [];
  return {
    add: (n) => void nudges.push(n),
    hasRef: (ref) => nudges.some((n) => n.signalRef === ref),
    all: () => [...nudges],
  };
}

/** A pause of monitoring. `manual` breaks use the daily quota; `scheduled` ones (pomodoro, meal) do not. */
export interface Break {
  id: string;
  userId: string;
  sessionId: string;
  kind: "manual" | "scheduled";
  startedAt: string;
  /** Server time the allowed break ends; absence counts from here. */
  allowedUntil: string;
  endedAt: string | null;
}
export interface BreakStore {
  add(b: Break): void;
  remove(id: string): void;
  all(): Break[];
}
export function createMemoryBreakStore(): BreakStore {
  const breaks: Break[] = [];
  return {
    add: (b) => void breaks.push(b),
    remove: (id) => {
      const i = breaks.findIndex((b) => b.id === id);
      if (i >= 0) breaks.splice(i, 1);
    },
    all: () => [...breaks],
  };
}

/**
 * A platform outage or an admin-declared incident that can waive a gap. The platform detects
 * server and network outages itself (internal health log); browser-reported values are never used.
 */
export interface Outage {
  id: string;
  source: "incident" | "platform";
  startedAt: string;
  /** `null` while it is still going on. */
  endedAt: string | null;
}

/** Audit record: this gap was waived because it overlaps this outage. One per signal. */
export interface OutageWaiver {
  signalRef: string;
  userId: string;
  sessionId: string;
  outageId: string;
  source: Outage["source"];
  gapStartedAt: string;
  gapEndedAt: string;
  marginSeconds: number;
  recordedAt: string;
}
export interface WaiverStore {
  add(w: OutageWaiver): void;
  all(): OutageWaiver[];
}
export function createMemoryWaiverStore(): WaiverStore {
  const waivers = new Map<string, OutageWaiver>();
  return {
    add: (w) => void waivers.set(w.signalRef, w),
    all: () => [...waivers.values()],
  };
}

/** Server-side heartbeat history: server times only, never the browser clock. */
export interface HeartbeatStore {
  add(sessionId: string, at: string): void;
  list(sessionId: string): string[];
}
export function createMemoryHeartbeatStore(): HeartbeatStore {
  const bySession = new Map<string, string[]>();
  return {
    add: (id, at) => void bySession.set(id, [...(bySession.get(id) ?? []), at]),
    list: (id) => [...(bySession.get(id) ?? [])],
  };
}

/** Aggregates heartbeat times into presence intervals; a pause of `gapMs` or more starts a new one. */
export function presenceIntervals(
  times: readonly string[],
  gapMs: number,
): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  for (const t of [...times].sort()) {
    const last = out[out.length - 1];
    if (last && Date.parse(t) - Date.parse(last.to) < gapMs) last.to = t;
    else out.push({ from: t, to: t });
  }
  return out;
}

export interface MonitorState {
  heartbeats: HeartbeatStore;
  waivers: WaiverStore;
  breaks: BreakStore;
  nudges: NudgeStore;
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
  /** Declared incidents and platform outages that apply to the user; none until wired. */
  listOutages: (userId: string) => Promise<readonly Outage[]>;
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
  deps.state.heartbeats.add(session.id, session.startedAt);
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
  deps.state.heartbeats.add(s.id, s.lastHeartbeatAt);
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

/**
 * Soft signals (looking away, head down, yawn, drowsy) only nudge (principle 3): each accepted
 * event is announced as `focus.signal_detected` (soft class) and answered with a nudge key the
 * client turns into a locale text. Nothing here opens a ticket, an urgent message or a fault.
 * Events below `monitor.ambiguous_confidence_below` are ignored; a repeat of the same event
 * (session, signal, start time) gives no second nudge. Hard signals are not handled here.
 */
export async function processSoftSignals(
  deps: MonitorDeps,
  session: MonitoringSession,
  events: FocusEvent[],
  now: Date,
): Promise<Nudge[]> {
  const answer = (await deps.readSettings(session.userId))["monitor.ambiguous_confidence_below"];
  const minConfidence =
    typeof answer === "number" && answer >= 0 && answer <= 1
      ? answer
      : SETTINGS["monitor.ambiguous_confidence_below"].default;
  const given: Nudge[] = [];
  for (const e of events) {
    const parsed = SoftSignalSchema.safeParse(e.type);
    if (!parsed.success || parsed.data === "late_night") continue;
    if (e.confidence < minConfidence) continue;
    const signalRef = `${parsed.data}-${session.id}-${e.startedAt}`;
    if (deps.state.nudges.hasRef(signalRef)) continue;
    await deps.publish(
      envelope(now, `focus-signal-${signalRef}`, "focus.signal_detected", session.userId, {
        sessionId: session.id,
        signal: parsed.data,
        signalClass: "soft",
        startedAt: e.startedAt,
        confidence: e.confidence,
      }),
    );
    const nudge: Nudge = {
      signalRef,
      userId: session.userId,
      sessionId: session.id,
      signal: parsed.data,
      messageKey: `monitor.nudge.${parsed.data}`,
      createdAt: now.toISOString(),
    };
    deps.state.nudges.add(nudge);
    given.push(nudge);
  }
  return given;
}

type PositiveKey =
  | "monitor.break_max_minutes"
  | "monitor.heartbeat_missing_seconds"
  | "monitor.urgent_chat_after_seconds"
  | "monitor.urgent_silent_fault_after_seconds"
  | "monitor.urgent_min_gap_minutes";

/** `monitor.outage_gap_margin_seconds`: zero is allowed; invalid answers fall back to the default. */
async function outageMarginSeconds(deps: MonitorDeps, userId: string): Promise<number> {
  const answer = (await deps.readSettings(userId))["monitor.outage_gap_margin_seconds"];
  return typeof answer === "number" && Number.isInteger(answer) && answer >= 0
    ? answer
    : SETTINGS["monitor.outage_gap_margin_seconds"].default;
}

/**
 * True when the gap [start, end] overlaps an outage widened by the margin on both sides (edges
 * inclusive; an open outage lasts until now). The first overlapping outage is recorded as the
 * audit cause, once per signal. Rules turns the flag into `waived_system`.
 */
async function overlapsOutage(deps: MonitorDeps, t: ReasonTicket, gapEnd: Date): Promise<boolean> {
  const margin = await outageMarginSeconds(deps, t.userId);
  const marginMs = margin * SECOND_MS;
  const gapStart = Date.parse(t.occurredAt);
  const hit = (await deps.listOutages(t.userId)).find(
    (o) =>
      Date.parse(o.startedAt) - marginMs <= gapEnd.getTime() &&
      (o.endedAt === null || Date.parse(o.endedAt) + marginMs >= gapStart),
  );
  if (!hit) return false;
  deps.state.waivers.add({
    signalRef: t.signalRef,
    userId: t.userId,
    sessionId: t.sessionId,
    outageId: hit.id,
    source: hit.source,
    gapStartedAt: t.occurredAt,
    gapEndedAt: gapEnd.toISOString(),
    marginSeconds: margin,
    recordedAt: gapEnd.toISOString(),
  });
  return true;
}

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
const MINUTE_MS = 60 * SECOND_MS;

/** The break not yet closed; it may be past its allowed end (the gap check needs that case). */
const openBreak = (deps: MonitorDeps, sessionId: string) =>
  deps.state.breaks.all().find((b) => b.sessionId === sessionId && b.endedAt === null);

/** Same UTC calendar day; the user's time zone is not known to monitor yet (see decisions.md). */
const sameDay = (a: string, b: Date) => a.slice(0, 10) === b.toISOString().slice(0, 10);

export type BreakResult =
  | { ok: true; break: Break }
  | {
      ok: false;
      error:
        | "session.not_found"
        | "break.already_running"
        | "break.quota_exceeded"
        | "break.not_running";
    };

/**
 * Starts a pause. A manual pause lasts up to `monitor.break_max_minutes` and at most
 * `monitor.breaks_per_day` start per day (beyond that: `break.quota_exceeded`, normal monitoring
 * continues). A scheduled pause (pomodoro break, meal block) lasts its planned `minutes` and
 * uses no quota. Announced as `break.started`; state changes after the event is published.
 */
export async function startBreak(
  deps: MonitorDeps,
  userId: string,
  input: { sessionId: string; kind: "manual" | "scheduled"; minutes?: number },
  now: Date,
): Promise<BreakResult> {
  const s = deps.state.sessions.get(userId, input.sessionId);
  if (!s || s.endedAt !== null) return { ok: false, error: "session.not_found" };
  const open = openBreak(deps, s.id);
  if (open) {
    // A break past its allowed end no longer blocks a new one; it is closed without a sign of life.
    if (Date.parse(open.allowedUntil) > now.getTime()) {
      return { ok: false, error: "break.already_running" };
    }
    await deps.publish(
      envelope(now, `break-ended-${open.id}`, "break.ended", userId, { sessionId: s.id }),
    );
    open.endedAt = open.allowedUntil;
  }
  const maxMinutes = await positiveSetting(deps, userId, "monitor.break_max_minutes");
  let minutes = maxMinutes;
  if (input.kind === "manual") {
    const answer = (await deps.readSettings(userId))["monitor.breaks_per_day"];
    const perDay =
      typeof answer === "number" && Number.isInteger(answer) && answer >= 0
        ? answer
        : SETTINGS["monitor.breaks_per_day"].default;
    const today = deps.state.breaks
      .all()
      .filter((b) => b.userId === userId && b.kind === "manual" && sameDay(b.startedAt, now));
    if (today.length >= perDay) return { ok: false, error: "break.quota_exceeded" };
  } else {
    minutes = input.minutes ?? maxMinutes;
  }
  const b: Break = {
    id: randomUUID(),
    userId,
    sessionId: s.id,
    kind: input.kind,
    startedAt: now.toISOString(),
    allowedUntil: new Date(now.getTime() + minutes * MINUTE_MS).toISOString(),
    endedAt: null,
  };
  // Stored before publishing so a concurrent start sees it; undone if the event is not sent.
  deps.state.breaks.add(b);
  try {
    await deps.publish(
      envelope(now, `break-started-${b.id}`, "break.started", userId, {
        sessionId: s.id,
        maxMinutes: minutes,
      }),
    );
  } catch (err) {
    deps.state.breaks.remove(b.id);
    throw err;
  }
  return { ok: true, break: b };
}

/** Ends the running pause; the end counts as a sign of life, so normal monitoring resumes from it. */
export async function endBreak(
  deps: MonitorDeps,
  userId: string,
  sessionId: string,
  now: Date,
): Promise<BreakResult> {
  const s = deps.state.sessions.get(userId, sessionId);
  if (!s || s.endedAt !== null) return { ok: false, error: "session.not_found" };
  const b = openBreak(deps, s.id);
  if (!b) return { ok: false, error: "break.not_running" };
  await deps.publish(
    envelope(now, `break-ended-${b.id}`, "break.ended", userId, { sessionId: s.id }),
  );
  b.endedAt = now.toISOString();
  s.lastHeartbeatAt = now.toISOString();
  deps.state.heartbeats.add(s.id, s.lastHeartbeatAt);
  return { ok: true, break: b };
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
      // During a break the gap starts at the end of the allowed break (never retroactive).
      const pause = openBreak(deps, s.id);
      const lastSign =
        pause && Date.parse(pause.allowedUntil) > Date.parse(s.lastHeartbeatAt)
          ? pause.allowedUntil
          : s.lastHeartbeatAt;
      if (now.getTime() - Date.parse(lastSign) < seconds * SECOND_MS) continue;
      const signalRef = `heartbeat_lost-${s.id}-${lastSign}`;
      if (deps.state.tickets.hasRef(signalRef)) continue;
      const ticket: ReasonTicket = {
        id: randomUUID(),
        userId: s.userId,
        sessionId: s.id,
        signal: "heartbeat_lost",
        signalRef,
        state: "open",
        occurredAt: lastSign,
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

/** Honest reasons of this type the user already used in the local week of the fault. */
async function honestReasonsUsed(deps: MonitorDeps, t: ReasonTicket, kind: ReasonKind) {
  const settings = await deps.readSettings(t.userId);
  const zoneAnswer = settings["calendar.time_zone"];
  const dayAnswer = settings["calendar.week_start_day"];
  const validZone = (z: unknown): z is string => {
    if (typeof z !== "string") return false;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: z });
      return true;
    } catch {
      return false;
    }
  };
  const timeZone = validZone(zoneAnswer) ? zoneAnswer : SETTINGS["calendar.time_zone"].default;
  const dayDef = SETTINGS["calendar.week_start_day"];
  const parsedDay = dayDef.schema.safeParse(dayAnswer);
  const weekStartDay = parsedDay.success ? parsedDay.data : dayDef.default;
  const week = (iso: string) => localWeekStart(new Date(iso), timeZone, weekStartDay);
  const thisWeek = week(t.occurredAt);
  return deps.state.tickets
    .all()
    .filter(
      (o) =>
        o.id !== t.id &&
        o.userId === t.userId &&
        o.reasonKind === kind &&
        o.scoredAs === "honest" &&
        week(o.occurredAt) === thisWeek,
    ).length;
}

async function reasonQuota(deps: MonitorDeps, userId: string): Promise<number> {
  const answer = (await deps.readSettings(userId))["reason.quota_per_week"];
  return typeof answer === "number" && Number.isInteger(answer) && answer >= 0
    ? answer
    : SETTINGS["reason.quota_per_week"].default;
}

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
  const outcome = decideReasonOutcome(
    await reasonQuota(deps, userId),
    await honestReasonsUsed(deps, t, input.kind),
  );
  const overlapsOutageNow = await overlapsOutage(deps, t, now);
  const previous = { ...t };
  t.state = "answered";
  t.answeredAt = now.toISOString();
  t.reasonKind = input.kind;
  t.scoredAs = outcome;
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
    // Rules scores the fault: an honest reason at the honest percentage, silence in full.
    // A reason beyond the weekly quota is sent as silence (`none`) but keeps its kind for audit.
    await deps.publish(
      envelope(now, `fault-detected-${t.signalRef}`, "fault.detected", userId, {
        signalRef: t.signalRef,
        type: t.signal,
        occurredAt: t.occurredAt,
        reason: outcome === "honest" ? "given" : "none",
        reasonRef: outcome === "honest" ? t.id : null,
        reasonKind: input.kind,
        overlapsOutage: overlapsOutageNow,
      }),
    );
  } catch (err) {
    // The answer is not recorded unless it was announced; the user can answer again.
    Object.assign(t, previous);
    delete t.answeredAt;
    delete t.reasonKind;
    delete t.reasonText;
    delete t.scoredAs;
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
        const overlaps = await overlapsOutage(deps, t, now);
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
            overlapsOutage: overlaps,
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
