import type { Task } from "@my-wife/contracts";
import type { ReactNode } from "react";
import { translate, type Locale } from "../lib/i18n";
import {
  blockStatus,
  blocksOfDay,
  describeRepeat,
  type BlockStatus,
  type ScheduleData,
  type ScheduleRecurrence,
  type SyncLink,
} from "../lib/schedule-screen";
import { weekDays } from "../lib/week-planner";
import { Card, Chip, Dialog, EmptyState, ErrorState, Skeleton, Tabs } from "./ui";

export type ScheduleStatus = "loading" | "ready" | "empty" | "error";
export type ScheduleTab = "today" | "week" | "calendar" | "review";
export const SCHEDULE_TABS: ScheduleTab[] = ["today", "week", "calendar", "review"];

export interface ScheduleViewProps {
  locale: Locale;
  status: ScheduleStatus;
  data: ScheduleData | null;
  /** The user's today (`YYYY-MM-DD`) and the time of day (`HH:MM`); parameters so tests can fix them. */
  today: string;
  nowHm: string;
  /** Day shown in the timeline. */
  day: string;
  tab: ScheduleTab;
  /** Block whose details are open. */
  detailId: string | null;
  onTab: (tab: ScheduleTab) => void;
  onDay: (day: string) => void;
  onDetails: (id: string) => void;
  onCloseDetails: () => void;
  onRetry: () => void;
  /** Content of the tabs that reuse the existing screens. */
  panels: Record<Exclude<ScheduleTab, "today">, ReactNode>;
}

const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const STATUS_TONE: Record<BlockStatus, "neutral" | "success" | "warning" | "danger"> = {
  done: "success",
  late: "danger",
  current: "warning",
  upcoming: "neutral",
  closed: "neutral",
};
const tag = (locale: Locale) => (locale === "vi" ? "vi-VN" : "en-US");

function dayLabel(locale: Locale, day: string, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(tag(locale), { ...opts, timeZone: "UTC" }).format(
    new Date(`${day}T00:00:00.000Z`),
  );
}

/** Details of one block: time, repeat, monitoring, sync per calendar, edit and open in calendar. */
export function BlockDetails(props: {
  locale: Locale;
  task: Task;
  recurrences: ScheduleRecurrence[];
  sync: SyncLink[] | null;
}) {
  const { locale, task, recurrences, sync } = props;
  const t = (key: string, params?: Record<string, string | number>) =>
    translate(locale, key, params);
  const repeat = describeRepeat(task, recurrences);
  const repeatText = !repeat
    ? t("schedule.repeat.none")
    : repeat.key === "schedule.repeat.weekly"
      ? t(repeat.key, {
          days: repeat.weekdays
            .map((d) => t(`calendar.weekday.${WEEKDAY_KEYS[d] ?? "sun"}`))
            .join(", "),
        })
      : repeat.key === "schedule.repeat.unknown"
        ? t(repeat.key)
        : t(repeat.key, { day: repeat.day });
  return (
    <dl className="schedule-details">
      <dt>{t("schedule.details.time")}</dt>
      <dd>
        {task.window
          ? t("schedule.time_range", { start: task.window.start, end: task.window.end })
          : t("schedule.no_window")}
        {" · "}
        {t("checklist.minutes", { minutes: task.estimatedMinutes })}
      </dd>
      <dt>{t("schedule.details.repeat")}</dt>
      <dd>{repeatText}</dd>
      <dt>{t("schedule.details.monitoring")}</dt>
      <dd>{t(`schedule.monitoring.${task.monitoringProfile}`)}</dd>
      <dt>{t("schedule.details.sync")}</dt>
      <dd>
        {sync === null ? (
          <Chip>{t("schedule.sync.unknown")}</Chip>
        ) : sync.length === 0 ? (
          <Chip>{t("schedule.sync.none")}</Chip>
        ) : (
          <span className="schedule-chips">
            {sync.map((link) => (
              <Chip key={link.target} tone={link.state === "error" ? "danger" : "neutral"}>
                {t(`schedule.sync.target.${link.target}`)}: {t(`schedule.sync.state.${link.state}`)}
              </Chip>
            ))}
          </span>
        )}
      </dd>
      <dd className="schedule-actions">
        <a className="button" href="/schedule?tab=week">
          {t("schedule.details.edit")}
        </a>{" "}
        <a className="button" href={`/schedule/calendar?day=${task.day}`}>
          {t("schedule.details.open_calendar")}
        </a>
      </dd>
    </dl>
  );
}

function TodayPanel(props: ScheduleViewProps & { data: ScheduleData }) {
  const { locale, data, today, nowHm, day } = props;
  const t = (key: string, params?: Record<string, string | number>) =>
    translate(locale, key, params);
  const blocks = blocksOfDay(data.tasks, day);
  const running = blocks.find((b) => blockStatus(b, today, nowHm) === "current");
  const connected = data.sync?.filter((l) => l.state === "ready" || l.state === "syncing") ?? [];
  const detail = data.tasks.find((b) => b.id === props.detailId) ?? null;

  return (
    <div>
      <div className="schedule-strip" role="group" aria-label={t("schedule.week_strip")}>
        {weekDays(data.week.firstDay).map((d) => (
          <button
            key={d}
            type="button"
            data-day={d}
            className="schedule-strip-day"
            aria-pressed={d === day}
            aria-current={d === today ? "date" : undefined}
            onClick={() => props.onDay(d)}
          >
            <span>{dayLabel(locale, d, { weekday: "short" })}</span>
            <strong>{dayLabel(locale, d, { day: "numeric" })}</strong>
          </button>
        ))}
      </div>

      <p className="schedule-chips" aria-label={t("schedule.sync.title")}>
        {data.sync === null ? (
          <Chip>{t("schedule.sync.unknown")}</Chip>
        ) : connected.length === 0 ? (
          <Chip>{t("schedule.sync.none")}</Chip>
        ) : (
          connected.map((l) => (
            <Chip key={l.target}>
              {t(`schedule.sync.target.${l.target}`)}: {t(`schedule.sync.state.${l.state}`)}
            </Chip>
          ))
        )}
      </p>

      {running ? (
        <Card className="schedule-running">
          <strong>{t("schedule.running")}</strong>
          <p>
            {running.title}
            {running.window
              ? ` · ${t("schedule.time_range", { start: running.window.start, end: running.window.end })}`
              : ""}
          </p>
        </Card>
      ) : null}

      {blocks.length === 0 ? (
        <p className="schedule-empty">{t("schedule.day_empty")}</p>
      ) : (
        <ol className="schedule-timeline">
          {blocks.map((b) => {
            const st = blockStatus(b, today, nowHm);
            return (
              <li key={b.id} className={`schedule-block schedule-${st}`}>
                <div className="schedule-block-text">
                  <span className="schedule-block-time">
                    {b.window
                      ? t("schedule.time_range", { start: b.window.start, end: b.window.end })
                      : t("schedule.no_window")}
                  </span>
                  <span className="schedule-block-title">{b.title}</span>
                  <Chip tone={STATUS_TONE[st]}>{t(`schedule.status.${st}`)}</Chip>
                </div>
                <button
                  type="button"
                  className="button"
                  data-details={b.id}
                  onClick={() => props.onDetails(b.id)}
                >
                  {t("schedule.details.button")}
                </button>
              </li>
            );
          })}
        </ol>
      )}

      <Dialog
        open={detail !== null}
        title={detail?.title ?? ""}
        closeLabel={t("schedule.details.close")}
        onClose={props.onCloseDetails}
      >
        {detail ? (
          <BlockDetails
            locale={locale}
            task={detail}
            recurrences={data.recurrences}
            sync={data.sync}
          />
        ) : null}
      </Dialog>
    </div>
  );
}

/** Presentational schedule screen: tabs, week strip, timeline and block details. */
export function ScheduleView(props: ScheduleViewProps) {
  const { locale, status, data } = props;
  const t = (key: string) => translate(locale, key);

  if (status === "loading") {
    return (
      <div className="schedule-root">
        <Skeleton label={t("schedule.loading")} height="8rem" />
        <p role="status">{t("schedule.loading")}</p>
      </div>
    );
  }
  if (status === "error") {
    return (
      <div className="schedule-root">
        <ErrorState
          title={t("schedule.error")}
          retryLabel={t("schedule.retry")}
          onRetry={props.onRetry}
        />
      </div>
    );
  }
  if (status === "empty" || !data) {
    return (
      <div className="schedule-root">
        <EmptyState title={t("schedule.empty")} />
      </div>
    );
  }
  return (
    <div className="schedule-root">
      <Tabs
        label={t("schedule.tabs")}
        value={props.tab}
        onChange={(id) => props.onTab(id as ScheduleTab)}
        tabs={[
          {
            id: "today",
            label: t("schedule.tab.today"),
            content: <TodayPanel {...props} data={data} />,
          },
          { id: "week", label: t("schedule.tab.week"), content: props.panels.week },
          { id: "calendar", label: t("schedule.tab.calendar"), content: props.panels.calendar },
          { id: "review", label: t("schedule.tab.review"), content: props.panels.review },
        ]}
      />
    </div>
  );
}
