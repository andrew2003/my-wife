import { ListFaultsResponseSchema, ReasonKindSchema } from "@my-wife/contracts";
import type { z } from "zod";
import { systemClock, type Clock } from "./countdown";

export type ReasonKind = z.infer<typeof ReasonKindSchema>;
/** Every reason the monitor accepts, in contract order. */
export const REASON_KINDS: readonly ReasonKind[] = ReasonKindSchema.options;

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** A running focus session as the screen needs it; times are UTC ms. */
export interface FocusSession {
  id: string;
  startedAtMs: number;
  endsAtMs: number;
  durationMinutes: number;
  phase: "work" | "break" | "done";
  /** Length of the break that follows the work phase, from the user's pomodoro settings. */
  breakMinutes: number;
  /** Server time minus device time, measured when the session was fetched. */
  serverOffsetMs: number;
}

/** Share of the work phase still to run, from 1 to 0, computed from the end time. */
export function ringFraction(session: FocusSession, serverNowMs: number): number {
  const total = session.endsAtMs - session.startedAtMs;
  if (total <= 0) return 0;
  return Math.min(1, Math.max(0, (session.endsAtMs - serverNowMs) / total));
}

/** Percentage of the work phase already elapsed. */
export function pomodoroPercent(session: FocusSession, serverNowMs: number): number {
  return Math.round((1 - ringFraction(session, serverNowMs)) * 100);
}

/** Whole seconds left to answer an urgent prompt; never negative. */
export function urgentSecondsLeft(deadlineMs: number, serverNowMs: number): number {
  return Math.max(0, Math.ceil((deadlineMs - serverNowMs) / 1000));
}

/** How many items happened at or after the session start. */
export function countSince(items: { occurredAt: string }[], sinceMs: number): number {
  return items.filter((i) => Date.parse(i.occurredAt) >= sinceMs).length;
}

/** Reads one session from the schedule service; null on any failure. */
export async function loadFocusSession(
  sessionId: string,
  clock: Clock = systemClock,
  doFetch: FetchLike = fetch,
): Promise<FocusSession | null> {
  // No session id (the screen opened without one): nothing to ask the server for.
  if (sessionId === "") return null;
  try {
    const before = clock.now();
    const res = await doFetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      cache: "no-store",
    });
    const body = (await res.json()) as {
      ok?: boolean;
      data?: {
        session?: {
          id: string;
          startedAt: string;
          durationMinutes: number;
          plannedEndAt: string;
          serverNow: string;
          phase: FocusSession["phase"];
          break: { startedAt: string; endsAt: string } | null;
        };
      };
    };
    const s = body.data?.session;
    if (!res.ok || !body.ok || !s) return null;
    const mid = (before + clock.now()) / 2;
    const breakMs = s.break ? Date.parse(s.break.endsAt) - Date.parse(s.break.startedAt) : 0;
    return {
      id: s.id,
      startedAtMs: Date.parse(s.startedAt),
      endsAtMs: Date.parse(s.plannedEndAt),
      durationMinutes: s.durationMinutes,
      phase: s.phase,
      breakMinutes: Math.round(breakMs / 60_000),
      serverOffsetMs: Date.parse(s.serverNow) - mid,
    };
  } catch {
    return null;
  }
}

/** Faults recorded since the session began (read from the fault ledger). Null on failure. */
export async function loadFaultCount(
  sinceMs: number,
  doFetch: FetchLike = fetch,
): Promise<number | null> {
  try {
    const res = await doFetch("/api/faults", { cache: "no-store" });
    if (!res.ok) return null;
    const parsed = ListFaultsResponseSchema.safeParse(await res.json());
    if (!parsed.success || !parsed.data.ok) return null;
    return countSince(parsed.data.data.faults, sinceMs);
  } catch {
    return null;
  }
}

const post = async (doFetch: FetchLike, url: string, body?: unknown): Promise<boolean> => {
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return res.ok;
  } catch {
    return false;
  }
};

/** Pause uses a break, so the monitor's quota and length limit apply. False when refused. */
export const pauseSession = (sessionId: string, doFetch: FetchLike = fetch) =>
  post(doFetch, "/api/monitor/breaks/start", { sessionId });

export const resumeSession = (sessionId: string, doFetch: FetchLike = fetch) =>
  post(doFetch, "/api/monitor/breaks/end", { sessionId });

/** Answers an open urgent ticket; true only when the server accepted it. */
export const giveReason = (ticketId: string, kind: ReasonKind, doFetch: FetchLike = fetch) =>
  post(doFetch, "/api/monitor/reasons", { ticketId, kind });

/** Stops the work session, then ends monitoring. */
export async function finishEarly(sessionId: string, doFetch: FetchLike = fetch): Promise<boolean> {
  const stopped = await post(doFetch, `/api/sessions/${encodeURIComponent(sessionId)}/stop`);
  const ended = await post(doFetch, `/api/monitor/sessions/${encodeURIComponent(sessionId)}/end`);
  return stopped && ended;
}

export interface LeaveReason {
  kind: ReasonKind;
  /** Open reason ticket, when an urgent prompt exists; without one only the session ends. */
  ticketId: string | null;
}

/** Leaving is allowed at any time; the reason is sent first so it counts. */
export async function leaveWithReason(
  sessionId: string,
  reason: LeaveReason,
  doFetch: FetchLike = fetch,
): Promise<boolean> {
  if (reason.ticketId) {
    await post(doFetch, "/api/monitor/reasons", { ticketId: reason.ticketId, kind: reason.kind });
  }
  return finishEarly(sessionId, doFetch);
}

export interface OpenTicket {
  ticketId: string;
  /** Server time (UTC ms) when the silence fault would be raised. */
  answerByMs: number;
}

/**
 * Reads the open urgent ticket, if any. The monitor service has no read route for tickets yet,
 * so a 404 or any failure means "none"; the prompt appears once the route exists.
 */
export async function loadOpenTicket(doFetch: FetchLike = fetch): Promise<OpenTicket | null> {
  try {
    const res = await doFetch("/api/monitor/tickets/open", { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      ok?: boolean;
      data?: { ticket?: { id: string; answerBy: string } | null };
    };
    const t = body.data?.ticket;
    if (!body.ok || !t) return null;
    const answerByMs = Date.parse(t.answerBy);
    return Number.isFinite(answerByMs) ? { ticketId: t.id, answerByMs } : null;
  } catch {
    return null;
  }
}
