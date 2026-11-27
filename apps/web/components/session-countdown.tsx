"use client";

import { useEffect, useRef, useState } from "react";
import {
  createCountdown,
  documentVisibility,
  formatRemaining,
  loadActiveSession,
  type ActiveSession,
  type Clock,
  type Ticker,
  type VisibilitySource,
} from "../lib/countdown";
import { createEndSound, loadEndSoundSettings, type EndSound } from "../lib/end-sound";
import { translate, type Locale } from "../lib/i18n";
import { browserPipApi, isPipSupported, openCountdownPip, type CountdownPip } from "../lib/pip";

/** Button that moves the countdown into a floating window; shows a hint where unsupported. */
export function PipToggle({ locale, text }: { locale: Locale; text: string }) {
  const pipRef = useRef<CountdownPip | null>(null);
  const [open, setOpen] = useState(false);
  const [supported, setSupported] = useState<boolean | null>(null);
  const inFlight = useRef(false);
  useEffect(() => {
    setSupported(isPipSupported(browserPipApi()));
    return () => pipRef.current?.close();
  }, []);
  useEffect(() => {
    pipRef.current?.update(text);
  }, [text]);
  if (supported === null) return null;
  if (!supported) {
    return <span className="pip-hint">{translate(locale, "pip.unsupported")}</span>;
  }
  const toggle = async () => {
    if (pipRef.current) {
      pipRef.current.close();
      return;
    }
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const pip = await openCountdownPip(browserPipApi(), {
        title: translate(locale, "countdown.label"),
        onClose: () => {
          pipRef.current = null;
          setOpen(false);
        },
      });
      if (!pip) return;
      pipRef.current = pip;
      pip.update(text);
      setOpen(true);
    } finally {
      inFlight.current = false;
    }
  };
  return (
    <button type="button" className="pip-toggle" onClick={() => void toggle()}>
      {translate(locale, open ? "pip.close" : "pip.open")}
    </button>
  );
}

/** One user click unlocks audio; the sound is then scheduled at the end time with Web Audio. */
export function EndSoundToggle({
  locale,
  endsAtMs,
  serverOffsetMs,
  clock,
}: {
  locale: Locale;
  endsAtMs: number;
  serverOffsetMs?: number;
  clock?: Clock;
}) {
  const soundRef = useRef<EndSound | null>(null);
  const [on, setOn] = useState(false);
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    const settings = loadEndSoundSettings();
    setEnabled(settings.enabled);
    soundRef.current = createEndSound({ settings });
    return () => soundRef.current?.cancel();
  }, []);
  useEffect(() => {
    if (!on) return;
    const c = clock ?? { now: () => Date.now() };
    soundRef.current?.schedule(endsAtMs, { now: () => c.now() + (serverOffsetMs ?? 0) });
  }, [on, endsAtMs, serverOffsetMs, clock]);
  if (!enabled) return null;
  if (on) return <span className="sound-on">{translate(locale, "sound.enabled")}</span>;
  return (
    <button
      type="button"
      className="sound-toggle"
      onClick={() => void soundRef.current?.unlock().then(() => setOn(true))}
    >
      {translate(locale, "sound.enable")}
    </button>
  );
}

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
      resync={() => loadActiveSession(taskId).then((s) => s?.serverOffsetMs ?? null)}
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
  visibility?: VisibilitySource;
  resync?: () => Promise<number | null>;
}) {
  const { locale, endsAtMs, serverOffsetMs, clock, ticker, resync } = props;
  const visibility = props.visibility ?? documentVisibility;
  const resyncRef = useRef(resync);
  resyncRef.current = resync;
  const [remaining, setRemaining] = useState<number | null>(null);
  useEffect(() => {
    const c = createCountdown({
      endsAtMs,
      serverOffsetMs,
      clock,
      ticker,
      visibility,
      resync: () => resyncRef.current?.() ?? Promise.resolve(null),
      onTick: setRemaining,
    });
    return c.stop;
  }, [endsAtMs, serverOffsetMs, clock, ticker, visibility]);
  if (remaining === null) return null;
  return (
    <>
      <SessionCountdownView locale={locale} remaining={remaining} />
      <PipToggle locale={locale} text={formatRemaining(remaining)} />
      <EndSoundToggle
        locale={locale}
        endsAtMs={endsAtMs}
        serverOffsetMs={serverOffsetMs}
        clock={clock}
      />
    </>
  );
}
