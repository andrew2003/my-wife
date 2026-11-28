import type { ReactNode } from "react";
import { formatRemaining } from "../lib/countdown";
import { REASON_KINDS, type FocusSession, type ReasonKind } from "../lib/focus-session";
import { translate, type Locale } from "../lib/i18n";
import { Button, Card, Dialog, ProgressBar, StatTile } from "./ui";

const RING_RADIUS = 90;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

export interface UrgentPrompt {
  ticketId: string;
  /** Seconds left before the silence fault, counted from the server clock. */
  secondsLeft: number;
}

export interface FocusSessionViewProps {
  locale: Locale;
  session: FocusSession;
  remainingSeconds: number;
  /** Share of the work phase left, 0 to 1. */
  fraction: number;
  pomodoroPercent: number;
  distractions: number;
  /** Null while the fault ledger could not be read. */
  faults: number | null;
  paused: boolean;
  urgent: UrgentPrompt | null;
  leaveOpen?: boolean;
  /** Camera panel, supplied by the screen. */
  camera: ReactNode;
  /** Floating window, end sound and similar controls. */
  extras?: ReactNode;
  onPause: () => void;
  onResume: () => void;
  onFinish: () => void;
  /** Opens the leave dialog. */
  onLeave: () => void;
  onCloseLeave?: () => void;
  onFullscreen: () => void;
  /** Reason chosen for the urgent prompt or for leaving. */
  onReason: (kind: ReasonKind) => void;
}

/** Presentational focus session screen: no timers, no network, so it can be rendered in tests. */
export function FocusSessionView(props: FocusSessionViewProps) {
  const { locale, session, urgent } = props;
  const t = (key: string, params?: Record<string, string | number>) =>
    translate(locale, key, params);
  const offset = RING_LENGTH * (1 - props.fraction);
  const reasonButtons = (onPick: (k: ReasonKind) => void) => (
    <div className="focus-reasons">
      {REASON_KINDS.map((kind) => (
        <Button key={kind} onClick={() => onPick(kind)}>
          {t(`focus.reason.${kind}`)}
        </Button>
      ))}
    </div>
  );
  return (
    <div className="focus-root">
      {urgent ? (
        <div role="alert" className="focus-urgent">
          <strong>{t("focus.urgent.title")}</strong>
          <p>{t("focus.urgent.body", { time: formatRemaining(urgent.secondsLeft) })}</p>
          {reasonButtons(props.onReason)}
        </div>
      ) : null}
      <Card className="focus-ring-card">
        <p className="focus-phase">{t(`focus.phase.${session.phase}`)}</p>
        <div className="focus-ring">
          <svg viewBox="0 0 200 200" aria-hidden="true" focusable="false">
            <circle className="focus-ring-track" cx="100" cy="100" r={RING_RADIUS} />
            <circle
              className="focus-ring-value"
              cx="100"
              cy="100"
              r={RING_RADIUS}
              strokeDasharray={RING_LENGTH}
              strokeDashoffset={offset}
            />
          </svg>
          <span className="focus-time mw-tabular" role="timer" aria-label={t("countdown.label")}>
            {formatRemaining(props.remainingSeconds)}
          </span>
        </div>
        {props.paused ? <p className="focus-paused">{t("focus.paused")}</p> : null}
        <ProgressBar
          value={props.pomodoroPercent}
          label={t("focus.pomodoro", { minutes: session.durationMinutes })}
        />
        <p className="mw-hint">{t("focus.next_break", { minutes: session.breakMinutes })}</p>
      </Card>
      <div className="focus-stats">
        <StatTile label={t("focus.distractions")} value={String(props.distractions)} />
        <StatTile
          label={t("focus.faults")}
          value={props.faults === null ? t("focus.unknown") : String(props.faults)}
        />
      </div>
      <div className="focus-actions">
        {props.paused ? (
          <Button variant="primary" onClick={props.onResume}>
            {t("focus.resume")}
          </Button>
        ) : (
          <Button onClick={props.onPause}>{t("focus.pause")}</Button>
        )}
        <Button onClick={props.onFinish}>{t("focus.finish")}</Button>
        <Button variant="danger" onClick={props.onLeave}>
          {t("focus.leave")}
        </Button>
        <Button variant="quiet" onClick={props.onFullscreen}>
          {t("focus.fullscreen")}
        </Button>
      </div>
      {props.extras ? <div className="focus-extras">{props.extras}</div> : null}
      <Card className="focus-camera">
        <h2>{t("focus.camera")}</h2>
        {props.camera}
        <p className="focus-privacy">{t("focus.privacy")}</p>
      </Card>
      <Dialog
        open={props.leaveOpen ?? false}
        title={t("focus.leave.title")}
        closeLabel={t("focus.close")}
        onClose={props.onCloseLeave ?? (() => {})}
      >
        <p>{t("focus.leave.body")}</p>
        {reasonButtons(props.onReason)}
      </Dialog>
    </div>
  );
}
