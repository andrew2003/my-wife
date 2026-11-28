import type { RoutineLevel } from "@my-wife/contracts";
import { translate, type Locale } from "../lib/i18n";
import { formatWakeTime, type WakeCardState } from "../lib/wake";
import { Card, EmptyState, ErrorState, SegmentedControl, Skeleton } from "./ui";
import {
  LEVEL_ORDER,
  ROUTINE_LEVEL_KEYS,
  type RoutineName,
  type RoutineSettingKey,
  type RoutinesData,
} from "../lib/routines";

export type RoutinesStatus = "loading" | "ready" | "empty" | "error";
export type SaveState = "idle" | "saving" | "failed";

export interface SaveNotice {
  key: RoutineSettingKey;
  direction: string;
  effectiveFrom: string;
}

export interface RoutinesViewProps {
  locale: Locale;
  status: RoutinesStatus;
  data: RoutinesData | null;
  saveState: SaveState;
  notice: SaveNotice | null;
  timeZone: string;
  /** Seven days of the current week; null when the week is unknown (strips are hidden). */
  week: string[] | null;
  /** Today's recorded wake-up for the banner. */
  wake: WakeCardState;
  onChange: (key: RoutineSettingKey, value: string | number) => void;
  onRefresh: () => void;
}

/** Shared loading, empty and error states of the routines screens; null means ready. */
export function routinesStatusView(props: RoutinesViewProps) {
  const t = (key: string) => translate(props.locale, key);
  if (props.status === "loading") return <Skeleton label={t("routines.loading")} height="8rem" />;
  if (props.status === "empty") return <EmptyState title={t("routines.empty")} />;
  if (props.status === "error" || !props.data) {
    return (
      <ErrorState
        title={t("routines.error")}
        retryLabel={t("routines.retry")}
        onRetry={props.onRefresh}
      />
    );
  }
  return null;
}

/** Result of the last save: the effective time of a loosening, and a failed-save alert. */
export function SaveFeedback(props: RoutinesViewProps) {
  const t = (key: string, params?: Record<string, string | number>) =>
    translate(props.locale, key, params);
  const { notice } = props;
  const when = notice
    ? new Intl.DateTimeFormat(props.locale === "vi" ? "vi-VN" : "en-US", {
        dateStyle: "medium",
        timeZone: props.timeZone,
      }).format(new Date(notice.effectiveFrom))
    : "";
  return (
    <>
      {props.saveState === "saving" ? <p role="status">{t("routines.saving")}</p> : null}
      {props.saveState === "failed" ? <p role="alert">{t("routines.error.save")}</p> : null}
      {notice ? (
        <p role="status">
          {notice.direction === "loosening"
            ? t("routines.saved_loosening", { date: when })
            : t("routines.saved_now")}
        </p>
      ) : null}
    </>
  );
}

/** Seven days of the week; no check-in history route exists yet, so every day is unknown. */
function WeekStrip({ props, name }: { props: RoutinesViewProps; name: RoutineName }) {
  const t = (key: string) => translate(props.locale, key);
  if (!props.week) return null;
  const tag = props.locale === "vi" ? "vi-VN" : "en-US";
  const weekday = new Intl.DateTimeFormat(tag, { weekday: "short", timeZone: "UTC" });
  return (
    <ol
      className="routine-strip"
      aria-label={`${t("routines.week.title")}: ${t(`routines.routine.${name}`)}`}
    >
      {props.week.map((day) => {
        const date = new Date(`${day}T00:00:00.000Z`);
        const label = weekday.format(date);
        return (
          <li
            key={day}
            className="routine-strip-day"
            aria-label={`${label} ${date.getUTCDate()}: ${t("routines.week.unknown")}`}
          >
            <span>{label}</span>
            <strong>{date.getUTCDate()}</strong>
            <span aria-hidden="true">·</span>
          </li>
        );
      })}
    </ol>
  );
}

/** Banner with today's recorded wake-up; hidden until a wake is recorded. */
function WakeBanner({ props }: { props: RoutinesViewProps }) {
  const { wake } = props;
  if (wake.status !== "recorded") return null;
  const t = (key: string, params?: Record<string, string | number>) =>
    translate(props.locale, key, params);
  return (
    <section className="routines-banner" aria-label={t("routines.banner.title")}>
      <h2>{t("routines.banner.title")}</h2>
      <p>
        {t("routines.banner.recorded", { time: formatWakeTime(wake.wakeTime, props.timeZone) })}{" "}
        {wake.minutesLate === 0
          ? t("routines.banner.on_time")
          : t("routines.banner.late", { minutes: wake.minutesLate })}
      </p>
      <a href="/routines/sleep">{t("routines.banner.link")}</a>
    </section>
  );
}

/** Presentational routine levels screen; state lives in the client wrapper. */
export function RoutinesView(props: RoutinesViewProps) {
  const t = (key: string, params?: Record<string, string | number>) =>
    translate(props.locale, key, params);
  const early = routinesStatusView(props);
  if (early || !props.data) return early;
  const { data } = props;
  const busy = props.saveState === "saving";
  return (
    <section className="routines" aria-label={t("routines.title")}>
      <h2>{t("routines.title")}</h2>
      <WakeBanner props={props} />
      <p>{t("routines.loosening")}</p>
      <SaveFeedback {...props} />
      <div className="routine-list">
        {(Object.keys(ROUTINE_LEVEL_KEYS) as RoutineName[]).map((name) => {
          const level = data.levels[name];
          const title = t(`routines.routine.${name}`);
          return (
            <Card key={name} className="routine-card">
              <h3>{title}</h3>
              <fieldset className="routine-level" disabled={busy}>
                <SegmentedControl
                  label={t("routines.level.label", { routine: title })}
                  value={level}
                  options={LEVEL_ORDER.map((l: RoutineLevel) => ({
                    value: l,
                    label: t(`routines.level.${l}`),
                  }))}
                  onChange={(v) => props.onChange(ROUTINE_LEVEL_KEYS[name], v)}
                />
              </fieldset>
              <p>{t(`routines.level.${level}.help`)}</p>
              <p className="mw-hint">{t(`routines.note.${name}`)}</p>
              <WeekStrip props={props} name={name} />
            </Card>
          );
        })}
      </div>
    </section>
  );
}
