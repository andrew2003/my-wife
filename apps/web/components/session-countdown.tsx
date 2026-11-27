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
import {
  DEFAULT_END_SOUND,
  END_SOUND_BOUNDS,
  createEndSound,
  loadEndSoundSettings,
  saveEndSoundSettings,
  type EndSound,
  type EndSoundSettings,
} from "../lib/end-sound";
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
  const [settings, setSettings] = useState<EndSoundSettings>(DEFAULT_END_SOUND);
  useEffect(() => {
    const loaded = loadEndSoundSettings();
    soundRef.current = createEndSound({ settings: loaded });
    setSettings(loaded);
    return () => soundRef.current?.cancel();
  }, []);
  useEffect(() => {
    if (!on || !settings.enabled) return;
    const c = clock ?? { now: () => Date.now() };
    soundRef.current?.schedule(endsAtMs, { now: () => c.now() + (serverOffsetMs ?? 0) });
  }, [on, settings, endsAtMs, serverOffsetMs, clock]);
  const apply = (next: EndSoundSettings) => {
    saveEndSoundSettings(typeof localStorage === "undefined" ? undefined : localStorage, next);
    soundRef.current?.configure(next);
    setSettings(next);
  };
  const unlock = () => void soundRef.current?.unlock().then(() => setOn(true));
  const numberField = (
    name: "frequencyHz" | "durationMs" | "volume" | "maxLatenessMs",
    labelKey: string,
    step: number,
  ) => (
    <label key={name}>
      {translate(locale, labelKey)}
      <input
        type="number"
        name={name}
        step={step}
        min={END_SOUND_BOUNDS[name].min}
        max={END_SOUND_BOUNDS[name].max}
        defaultValue={settings[name]}
        onChange={(e) => {
          const v = Number(e.target.value);
          const { min, max } = END_SOUND_BOUNDS[name];
          if (e.target.value !== "" && Number.isFinite(v) && v >= min && v <= max) {
            apply({ ...settings, [name]: v });
          }
        }}
      />
    </label>
  );
  return (
    <div className="sound-settings">
      <label>
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(e) => {
            apply({ ...settings, enabled: e.target.checked });
            if (e.target.checked) unlock();
          }}
        />
        {translate(locale, "sound.toggle")}
      </label>
      {settings.enabled && on && (
        <span className="sound-on">{translate(locale, "sound.enabled")}</span>
      )}
      {settings.enabled && !on && (
        <button type="button" className="sound-unlock" onClick={unlock}>
          {translate(locale, "sound.enable")}
        </button>
      )}
      {settings.enabled && (
        <>
          {numberField("frequencyHz", "sound.frequency", 10)}
          {numberField("durationMs", "sound.duration", 100)}
          {numberField("volume", "sound.volume", 0.1)}
          {numberField("maxLatenessMs", "sound.max_lateness", 1000)}
        </>
      )}
    </div>
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
