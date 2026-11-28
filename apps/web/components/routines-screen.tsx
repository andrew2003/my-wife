"use client";

import { useCallback, useEffect, useState } from "react";
import { loadTimeZone } from "../lib/budget-overview";
import type { Locale } from "../lib/i18n";
import { loadWakeToday, type WakeCardState } from "../lib/wake";
import {
  loadRoutines,
  loadRoutineWeek,
  saveRoutineSetting,
  type RoutineSettingKey,
  type RoutinesData,
} from "../lib/routines";
import {
  RoutinesView,
  type RoutinesStatus,
  type SaveNotice,
  type SaveState,
} from "./routines-view";
import { SleepView } from "./sleep-view";

/** Loads the routine settings and saves one change at a time; `kind` picks the screen. */
export function RoutinesScreen({ locale, kind }: { locale: Locale; kind: "levels" | "sleep" }) {
  const [status, setStatus] = useState<RoutinesStatus>("loading");
  const [data, setData] = useState<RoutinesData | null>(null);
  const [timeZone, setTimeZone] = useState("UTC");
  const [week, setWeek] = useState<string[] | null>(null);
  const [wake, setWake] = useState<WakeCardState>({ status: "none" });
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [notice, setNotice] = useState<SaveNotice | null>(null);

  const load = useCallback(async () => {
    setStatus("loading");
    const [res, zone, days, wakeToday] = await Promise.all([
      loadRoutines(),
      loadTimeZone(),
      loadRoutineWeek(),
      loadWakeToday(),
    ]);
    setTimeZone(zone);
    setWeek(days);
    setWake(wakeToday);
    setData(res.status === "ready" ? res.data : null);
    setStatus(res.status);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onChange = async (key: RoutineSettingKey, value: string | number) => {
    setSaveState("saving");
    setNotice(null);
    const res = await saveRoutineSetting(key, value);
    if (!res.ok) {
      setSaveState("failed");
      return;
    }
    setSaveState("idle");
    setNotice({ key, direction: res.direction, effectiveFrom: res.effectiveFrom });
    // The server decides what is effective now; a loosened level keeps its old value.
    await reloadQuiet();
  };

  const reloadQuiet = async () => {
    const res = await loadRoutines();
    if (res.status === "ready") setData(res.data);
  };

  const View = kind === "levels" ? RoutinesView : SleepView;
  return (
    <View
      locale={locale}
      status={status}
      data={data}
      saveState={saveState}
      notice={notice}
      timeZone={timeZone}
      week={week}
      wake={wake}
      onChange={(k, v) => void onChange(k, v)}
      onRefresh={() => void load()}
    />
  );
}
