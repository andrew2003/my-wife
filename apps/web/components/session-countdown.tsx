"use client";

import { useEffect, useState } from "react";
import {
  createCountdown,
  formatRemaining,
  loadActiveSession,
  type ActiveSession,
  type Clock,
  type Ticker,
} from "../lib/countdown";
import { translate, type Locale } from "../lib/i18n";

export function SessionCountdownView({ locale, remaining }: { locale: Locale; remaining: number }) {
  return (
    <span
      className="session-countdown"
      role="timer"
      aria-label={translate(locale, "countdown.label")}
    >
      {formatRemaining(remaining)}
    </span>
  );
}

/** Resumes the running session of a task from the server after a reload; empty when none. */
export function TaskCountdown({ locale, taskId }: { locale: Locale; taskId: string }) {
  const [session, setSession] = useState<ActiveSession | null>(null);
  useEffect(() => {
    let alive = true;
    void loadActiveSession(taskId).then((s) => alive && setSession(s));
    return () => {
      alive = false;
    };
  }, [taskId]);
  if (!session) return null;
  return (
    <SessionCountdown
      locale={locale}
      endsAtMs={session.endsAtMs}
      serverOffsetMs={session.serverOffsetMs}
    />
  );
}

/** Ticks every second from the stored end time; clock and ticker are injectable for tests. */
export function SessionCountdown(props: {
  locale: Locale;
  endsAtMs: number;
  serverOffsetMs?: number;
  clock?: Clock;
  ticker?: Ticker;
}) {
  const { locale, endsAtMs, serverOffsetMs, clock, ticker } = props;
  const [remaining, setRemaining] = useState<number | null>(null);
  useEffect(() => {
    const c = createCountdown({ endsAtMs, serverOffsetMs, clock, ticker, onTick: setRemaining });
    return c.stop;
  }, [endsAtMs, serverOffsetMs, clock, ticker]);
  if (remaining === null) return null;
  return <SessionCountdownView locale={locale} remaining={remaining} />;
}
