"use client";

import { useCallback, useEffect, useState } from "react";
import type { Task } from "@my-wife/contracts";
import { applyTaskAction, loadChecklist, type TaskAction } from "../lib/checklist";
import type { Locale } from "../lib/i18n";
import { ChecklistView, type ChecklistStatus } from "./checklist-view";

/** Loads one day's checklist and updates it in place after every saved action. */
export function DailyChecklist({ locale, date }: { locale: Locale; date: string }) {
  const [status, setStatus] = useState<ChecklistStatus>("loading");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setStatus("loading");
    const res = await loadChecklist(date);
    setTasks(res.tasks);
    setStatus(res.ok ? "ready" : "error");
  }, [date]);

  useEffect(() => {
    void load();
  }, [load]);

  const onAction = async (action: TaskAction, taskId: string) => {
    setPendingId(taskId);
    setErrorKey(null);
    const res = await applyTaskAction(action, taskId, tasks);
    setTasks(res.tasks);
    if (!res.ok) setErrorKey("checklist.action_error");
    setPendingId(null);
  };

  return (
    <ChecklistView
      locale={locale}
      status={status}
      tasks={tasks}
      pendingId={pendingId}
      errorKey={errorKey}
      onAction={(action, id) => void onAction(action, id)}
      onRetry={() => void load()}
    />
  );
}
