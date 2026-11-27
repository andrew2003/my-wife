import type { RoutineLevel } from "@my-wife/contracts";
import { translate, type Locale } from "../lib/i18n";
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
  onChange: (key: RoutineSettingKey, value: string | number) => void;
  onRefresh: () => void;
}

/** Shared loading, empty and error states of the routines screens; null means ready. */
export function routinesStatusView(props: RoutinesViewProps) {
  const t = (key: string) => translate(props.locale, key);
  if (props.status === "loading") return <p role="status">{t("routines.loading")}</p>;
  if (props.status === "empty") return <p>{t("routines.empty")}</p>;
  if (props.status === "error" || !props.data) {
    return (
      <div>
        <p role="alert">{t("routines.error")}</p>
        <button type="button" className="button" onClick={props.onRefresh}>
          {t("routines.retry")}
        </button>
      </div>
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

/** Presentational routine levels screen; state lives in the client wrapper. */
export function RoutinesView(props: RoutinesViewProps) {
  const t = (key: string) => translate(props.locale, key);
  const early = routinesStatusView(props);
  if (early || !props.data) return early;
  const { data } = props;
  const busy = props.saveState === "saving";
  return (
    <section className="routines" aria-label={t("routines.title")}>
      <h2>{t("routines.title")}</h2>
      <p>{t("routines.loosening")}</p>
      <SaveFeedback {...props} />
      <ul>
        {(Object.keys(ROUTINE_LEVEL_KEYS) as RoutineName[]).map((name) => {
          const level = data.levels[name];
          const id = `routine-level-${name}`;
          return (
            <li key={name}>
              <label htmlFor={id}>
                <strong>{t(`routines.routine.${name}`)}</strong>
              </label>{" "}
              <select
                id={id}
                value={level}
                disabled={busy}
                onChange={(e) => props.onChange(ROUTINE_LEVEL_KEYS[name], e.target.value)}
              >
                {LEVEL_ORDER.map((l: RoutineLevel) => (
                  <option key={l} value={l}>
                    {t(`routines.level.${l}`)}
                  </option>
                ))}
              </select>
              <p>{t(`routines.level.${level}.help`)}</p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
