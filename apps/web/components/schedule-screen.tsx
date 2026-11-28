"use client";

import { useCallback, useEffect, useState } from "react";
import type { Locale } from "../lib/i18n";
import { loadSchedule, localDate, localHm, type ScheduleData } from "../lib/schedule-screen";
import { MonthCalendarScreen } from "./month-calendar-screen";
import {
  SCHEDULE_TABS,
  ScheduleView,
  type ScheduleStatus,
  type ScheduleTab,
} from "./schedule-view";
import { WeekPlannerScreen } from "./week-planner-screen";
import { WeeklyReviewScreen } from "./weekly-review-screen";

/** Loads the week and wires the tabs, the day selection and the block details. */
export function ScheduleScreen({
  locale,
  initialTab,
  initialDay,
}: {
  locale: Locale;
  initialTab?: string;
  initialDay?: string;
}) {
  const [status, setStatus] = useState<ScheduleStatus>("loading");
  const [data, setData] = useState<ScheduleData | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [tab, setTab] = useState<ScheduleTab>(
    SCHEDULE_TABS.find((x) => x === initialTab) ?? "today",
  );
  const [day, setDay] = useState(() => localDate(new Date()));
  const [detailId, setDetailId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await loadSchedule();
    if (res.status === "ready") setData(res.data);
    setNow(new Date());
    setStatus(res.status);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <ScheduleView
      locale={locale}
      status={status}
      data={data}
      today={localDate(now)}
      nowHm={localHm(now)}
      day={day}
      tab={tab}
      detailId={detailId}
      onTab={setTab}
      onDay={setDay}
      onDetails={setDetailId}
      onCloseDetails={() => setDetailId(null)}
      onRetry={() => {
        setStatus("loading");
        void refresh();
      }}
      panels={{
        week: <WeekPlannerScreen locale={locale} />,
        calendar: <MonthCalendarScreen locale={locale} initialDay={initialDay} />,
        review: <WeeklyReviewScreen locale={locale} />,
      }}
    />
  );
}
