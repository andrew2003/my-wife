"use client";

import type { Task } from "@my-wife/contracts";
import { useCallback, useEffect, useState } from "react";
import type { Locale } from "../lib/i18n";
import {
  applyTemplate,
  approveWeek,
  loadPlanner,
  type PlannerTemplate,
  type PlannerWeek,
} from "../lib/week-planner";
import { WeekPlannerView, type WeekLoad, type WeekPlannerStatus } from "./week-planner-view";

/** Loads the week, applies a template and approves the plan. */
export function WeekPlannerScreen({ locale }: { locale: Locale }) {
  const [status, setStatus] = useState<WeekPlannerStatus>("loading");
  const [week, setWeek] = useState<PlannerWeek | null>(null);
  const [templates, setTemplates] = useState<PlannerTemplate[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [load, setLoad] = useState<WeekLoad | null>(null);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await loadPlanner();
    if (res.status === "ready") {
      setWeek(res.week);
      setTemplates(res.templates);
      setTasks(res.tasks);
    }
    setStatus(res.status);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onApply = async () => {
    if (!week || !selected) return;
    setBusy(true);
    setErrorKey(null);
    const res = await applyTemplate(week.id, selected);
    if (res.ok) {
      setLoad({ overloaded: res.overloaded, overloadMinutes: res.overloadMinutes });
      await refresh();
    } else {
      setErrorKey(res.errorKey);
    }
    setBusy(false);
  };

  const onApprove = async () => {
    if (!week) return;
    setBusy(true);
    setErrorKey(null);
    const res = await approveWeek(week.id);
    if (res.ok) await refresh();
    else setErrorKey(res.errorKey);
    setBusy(false);
  };

  return (
    <WeekPlannerView
      locale={locale}
      status={status}
      week={week}
      templates={templates}
      tasks={tasks}
      load={load}
      selectedTemplateId={selected}
      busy={busy}
      errorKey={errorKey}
      onSelectTemplate={setSelected}
      onApply={() => void onApply()}
      onApprove={() => void onApprove()}
      onRetry={() => {
        setStatus("loading");
        void refresh();
      }}
    />
  );
}
