"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createCountdown, documentVisibility, systemClock } from "../lib/countdown";
import {
  finishEarly,
  giveReason,
  leaveWithReason,
  loadFaultCount,
  loadFocusSession,
  loadOpenTicket,
  pauseSession,
  pomodoroPercent,
  resumeSession,
  ringFraction,
  urgentSecondsLeft,
  type FocusSession,
  type OpenTicket,
  type ReasonKind,
} from "../lib/focus-session";
import { translate, type Locale } from "../lib/i18n";
import { CameraMonitor } from "./camera-monitor";
import { FocusSessionView } from "./focus-session-view";
import { EndSoundToggle, PipToggle } from "./session-countdown";
import { formatRemaining } from "../lib/countdown";
import { EmptyState, ErrorState, Skeleton } from "./ui";

/** How often the fault count and the urgent ticket are re-read, in milliseconds. */
const POLL_MS = 15_000;

/** Loads the session, runs the server-clock countdown and wires every action. */
export function FocusSessionScreen(props: {
  locale: Locale;
  sessionId: string;
  heartbeatEverySeconds: number;
  forcedDelegate?: string;
}) {
  const { locale, sessionId } = props;
  const [status, setStatus] = useState<"loading" | "ready" | "error" | "ended">("loading");
  const [session, setSession] = useState<FocusSession | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [paused, setPaused] = useState(false);
  const [distractions, setDistractions] = useState(0);
  const [faults, setFaults] = useState<number | null>(null);
  const [ticket, setTicket] = useState<OpenTicket | null>(null);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const offsetRef = useRef(0);

  const load = useCallback(async () => {
    const s = await loadFocusSession(sessionId);
    if (!s) return setStatus("error");
    offsetRef.current = s.serverOffsetMs;
    setSession(s);
    setStatus(s.phase === "done" ? "ended" : "ready");
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The ring and the number come from the end time on the server clock, never from counted ticks.
  useEffect(() => {
    if (!session) return;
    const c = createCountdown({
      endsAtMs: session.endsAtMs,
      serverOffsetMs: session.serverOffsetMs,
      visibility: documentVisibility,
      resync: async () => {
        const fresh = await loadFocusSession(sessionId);
        if (fresh) offsetRef.current = fresh.serverOffsetMs;
        return fresh?.serverOffsetMs ?? null;
      },
      onTick: setRemaining,
    });
    return c.stop;
  }, [session, sessionId]);

  useEffect(() => {
    if (!session) return;
    let alive = true;
    const poll = async () => {
      const [count, open] = await Promise.all([
        loadFaultCount(session.startedAtMs),
        loadOpenTicket(),
      ]);
      if (!alive) return;
      setFaults(count);
      setTicket(open);
    };
    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [session]);

  const serverNowMs = session ? session.endsAtMs - remaining * 1000 : 0;

  const finish = async (run: () => Promise<boolean>) => {
    const ok = await run();
    if (ok) setStatus("ended");
    else setNotice(translate(locale, "focus.action_failed"));
  };

  const pick = (kind: ReasonKind) => {
    if (leaveOpen) {
      void finish(() => leaveWithReason(sessionId, { kind, ticketId: ticket?.ticketId ?? null }));
      setLeaveOpen(false);
      return;
    }
    if (ticket) {
      void giveReason(ticket.ticketId, kind).then((ok) =>
        ok ? setTicket(null) : setNotice(translate(locale, "focus.action_failed")),
      );
    }
  };

  if (sessionId === "") {
    return <EmptyState title={translate(locale, "focus.empty")} />;
  }
  if (status === "loading") return <Skeleton label={translate(locale, "focus.loading")} />;
  if (status === "error" || !session) {
    return (
      <ErrorState
        title={translate(locale, "focus.error")}
        retryLabel={translate(locale, "focus.retry")}
        onRetry={() => {
          setStatus("loading");
          void load();
        }}
      />
    );
  }
  if (status === "ended") {
    return <p role="status">{translate(locale, "focus.ended")}</p>;
  }

  return (
    <>
      <FocusSessionView
        locale={locale}
        session={session}
        remainingSeconds={remaining}
        fraction={ringFraction(session, serverNowMs)}
        pomodoroPercent={pomodoroPercent(session, serverNowMs)}
        distractions={distractions}
        faults={faults}
        paused={paused}
        urgent={
          ticket
            ? {
                ticketId: ticket.ticketId,
                secondsLeft: urgentSecondsLeft(
                  ticket.answerByMs,
                  systemClock.now() + offsetRef.current,
                ),
              }
            : null
        }
        leaveOpen={leaveOpen}
        onPause={() =>
          void pauseSession(sessionId).then((ok) =>
            ok ? setPaused(true) : setNotice(translate(locale, "focus.pause_refused")),
          )
        }
        onResume={() =>
          void resumeSession(sessionId).then((ok) =>
            ok ? setPaused(false) : setNotice(translate(locale, "focus.action_failed")),
          )
        }
        onFinish={() => void finish(() => finishEarly(sessionId))}
        onLeave={() => setLeaveOpen(true)}
        onCloseLeave={() => setLeaveOpen(false)}
        onFullscreen={() => {
          if (document.fullscreenElement) void document.exitFullscreen();
          else void document.documentElement.requestFullscreen?.();
        }}
        onReason={pick}
        extras={
          <>
            <PipToggle locale={locale} text={formatRemaining(remaining)} />
            <EndSoundToggle
              locale={locale}
              endsAtMs={session.endsAtMs}
              serverOffsetMs={session.serverOffsetMs}
            />
          </>
        }
        camera={
          <CameraMonitor
            locale={locale}
            sessionId={sessionId}
            heartbeatEverySeconds={props.heartbeatEverySeconds}
            forcedDelegate={props.forcedDelegate}
            onEvents={(events) => setDistractions((n) => n + events.length)}
          />
        }
      />
      {notice ? <p role="status">{notice}</p> : null}
    </>
  );
}
