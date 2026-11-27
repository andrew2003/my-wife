"use client";

import { useEffect, useState } from "react";
import type { Locale } from "../lib/i18n";
import { shiftMonth } from "../lib/month-calendar";
import { MonthCalendarView } from "./month-calendar-view";

/** The user's local today, taken from the device clock in the browser. */
function localToday(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Month navigation state around the presentational calendar. */
export function MonthCalendarScreen({ locale }: { locale: Locale }) {
  const [today, setToday] = useState<string | null>(null);
  const [cursor, setCursor] = useState({ year: 1970, month: 1 });

  useEffect(() => {
    const iso = localToday();
    setToday(iso);
    setCursor({ year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)) });
  }, []);

  if (today === null) {
    return (
      <MonthCalendarView
        locale={locale}
        status="loading"
        {...cursor}
        today=""
        onPrev={() => {}}
        onNext={() => {}}
        onToday={() => {}}
      />
    );
  }
  return (
    <MonthCalendarView
      locale={locale}
      status="ready"
      {...cursor}
      today={today}
      onPrev={() => setCursor((c) => shiftMonth(c.year, c.month, -1))}
      onNext={() => setCursor((c) => shiftMonth(c.year, c.month, 1))}
      onToday={() => {
        const iso = localToday();
        setToday(iso);
        setCursor({ year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)) });
      }}
    />
  );
}
