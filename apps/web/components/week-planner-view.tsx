import type { Task } from "@my-wife/contracts";
import { translate, type Locale } from "../lib/i18n";
import {
  groupByDay,
  splitMinutes,
  weekDays,
  type PlannerTemplate,
  type PlannerWeek,
} from "../lib/week-planner";
import { ScreenState, stateKeys } from "./screen-state";

const WEEK_PLANNER_STATE_KEYS = stateKeys("weekplan");

export type WeekPlannerStatus = "loading" | "ready" | "empty" | "error";

export interface WeekLoad {
  overloaded: boolean;
  overloadMinutes: number;
}

export interface WeekPlannerViewProps {
  locale: Locale;
  status: WeekPlannerStatus;
  week: PlannerWeek | null;
  templates: PlannerTemplate[];
  tasks: Task[];
  /** Known after a template was applied; null before. */
  load: WeekLoad | null;
  selectedTemplateId: string;
  busy: boolean;
  errorKey: string | null;
  onSelectTemplate: (id: string) => void;
  onApply: () => void;
  onApprove: () => void;
  onRetry: () => void;
}

/** Presentational week board: template picker, overload banner and the seven days. */
export function WeekPlannerView(props: WeekPlannerViewProps) {
  const { locale, status, week, templates, tasks, load, selectedTemplateId, busy, errorKey } =
    props;
  const t = (key: string, params?: Record<string, string | number>) =>
    translate(locale, key, params);

  if (status === "loading")
    return <ScreenState locale={locale} kind="loading" keys={WEEK_PLANNER_STATE_KEYS} />;
  if (status === "empty" || !week)
    return <ScreenState locale={locale} kind="empty" keys={WEEK_PLANNER_STATE_KEYS} />;
  if (status === "error") {
    return (
      <ScreenState
        locale={locale}
        kind="error"
        keys={WEEK_PLANNER_STATE_KEYS}
        onRetry={props.onRetry}
      />
    );
  }

  const tag = locale === "vi" ? "vi-VN" : "en-US";
  const dayLabel = (day: string) =>
    new Intl.DateTimeFormat(tag, {
      weekday: "short",
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    }).format(new Date(`${day}T00:00:00.000Z`));
  const duration = (minutes: number) => {
    const { hours, minutes: m } = splitMinutes(minutes);
    return hours > 0
      ? t("weekplan.duration_hm", { hours, minutes: m })
      : t("weekplan.duration_m", { minutes: m });
  };
  const days = weekDays(week.firstDay);
  const byDay = groupByDay(days, tasks);
  const isDraft = week.state === "draft";

  return (
    <div>
      <p>
        {t("weekplan.week_of", { date: dayLabel(week.firstDay) })}{" "}
        <span>{t(`weekplan.state.${week.state}`)}</span>
      </p>

      {load?.overloaded ? (
        <div role="alert" className="checklist-note">
          <strong>{t("weekplan.overload.title")}</strong>
          <p>{t("weekplan.overload.body", { over: duration(load.overloadMinutes) })}</p>
        </div>
      ) : load ? (
        <p role="status">{t("weekplan.load_ok")}</p>
      ) : null}
      {errorKey ? <p role="alert">{t(errorKey)}</p> : null}

      {isDraft ? (
        <section aria-label={t("weekplan.templates")}>
          <h2>{t("weekplan.templates")}</h2>
          {templates.length === 0 ? (
            <p>{t("weekplan.no_templates")}</p>
          ) : (
            <>
              <label>
                {t("weekplan.template_label")}{" "}
                <select
                  value={selectedTemplateId}
                  onChange={(e) => props.onSelectTemplate(e.target.value)}
                >
                  <option value="">{t("weekplan.template_placeholder")}</option>
                  {templates.map((tpl) => (
                    <option key={tpl.id} value={tpl.id}>
                      {tpl.name}
                    </option>
                  ))}
                </select>
              </label>{" "}
              <button
                type="button"
                className="button"
                disabled={busy || selectedTemplateId === ""}
                onClick={props.onApply}
              >
                {t("weekplan.apply")}
              </button>
            </>
          )}
        </section>
      ) : null}

      <section aria-label={t("weekplan.board")}>
        <h2>{t("weekplan.board")}</h2>
        {tasks.length === 0 ? <p>{t("weekplan.no_tasks")}</p> : null}
        <ol className="penalty-list">
          {days.map((day) => (
            <li key={day} className="penalty-entry">
              <h3>{dayLabel(day)}</h3>
              {byDay[day]!.length === 0 ? (
                <p>{t("weekplan.day_empty")}</p>
              ) : (
                <ul>
                  {byDay[day]!.map((task) => (
                    <li key={task.id}>
                      <span>{task.title}</span> <span>{duration(task.estimatedMinutes)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      </section>

      {isDraft ? (
        <button type="button" className="button" disabled={busy} onClick={props.onApprove}>
          {t("weekplan.approve")}
        </button>
      ) : null}
    </div>
  );
}
