"use client";

import { useCallback, useEffect, useState } from "react";
import type { Task } from "@my-wife/contracts";
import { loadTimeZone } from "../lib/budget-overview";
import { loadChecklist } from "../lib/checklist";
import { loadRemark } from "../lib/companion";
import { completeTask, localDayAndTime, type DashboardReaction } from "../lib/dashboard";
import {
  defaultExpressionSettings,
  loadExpressions,
  type ExpressionSettings,
} from "../lib/expressions";
import { translate, type Locale } from "../lib/i18n";
import { answerInboxQuestion, applyAnswered, loadInbox } from "../lib/inbox";
import {
  DashboardView,
  type DashboardMessages,
  type DashboardRemark,
  type DashboardStatus,
} from "./dashboard-view";

/** Follows the user's reduced-motion preference; defaults to reduced until it is known. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/** Loads the day, the remark and the messages once, and saves a tick through the schedule API. */
export function DashboardScreen({
  locale,
  artAvailable,
}: {
  locale: Locale;
  artAvailable: boolean;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const [status, setStatus] = useState<DashboardStatus>("loading");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [clock, setClock] = useState({ day: "", time: "00:00" });
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [tickedId, setTickedId] = useState<string | null>(null);
  const [reaction, setReaction] = useState<DashboardReaction | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [remark, setRemark] = useState<DashboardRemark>({ status: "loading" });
  const [expressions, setExpressions] = useState<ExpressionSettings>(defaultExpressionSettings);
  const [messages, setMessages] = useState<DashboardMessages>({ status: "loading" });
  const [now, setNow] = useState(() => new Date(0));

  const load = useCallback(async () => {
    setStatus("loading");
    const zone = await loadTimeZone();
    const at = new Date();
    const local = localDayAndTime(at, zone);
    setNow(at);
    setClock(local);
    const res = await loadChecklist(local.day);
    setTasks(res.tasks);
    setStatus(res.ok ? "ready" : "error");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void loadRemark("home", locale).then((res) =>
      setRemark(res.status === "ready" ? { status: "ready", text: res.text } : { status: "error" }),
    );
  }, [locale]);
  useEffect(() => {
    // A failed read keeps the default set, so the stickers still show.
    void loadExpressions().then((res) => {
      if (res.status === "ready") setExpressions(res.settings);
    });
  }, []);
  useEffect(() => {
    void loadInbox({}).then((res) =>
      setMessages(
        res.status === "ready" ? { status: "ready", items: res.items } : { status: res.status },
      ),
    );
  }, []);

  const onTick = async (taskId: string) => {
    setPendingId(taskId);
    setErrorKey(null);
    const res = await completeTask(taskId, tasks);
    setTasks(res.tasks);
    setPendingId(null);
    if (!res.ok) {
      setErrorKey("checklist.action_error");
      return;
    }
    setTickedId(taskId);
    setReaction({
      text: translate(locale, res.reaction.key, res.reaction.params),
      state: "task_done",
    });
  };

  const onAnswer = async (questionId: string, value: string) => {
    const res = await answerInboxQuestion(questionId, value);
    if (res.status !== "answered") return;
    // Answered here or elsewhere, the card shows the current state of the thread.
    setMessages((prev) =>
      prev.status === "ready"
        ? { status: "ready", items: applyAnswered(prev.items, questionId, value) }
        : prev,
    );
  };

  return (
    <DashboardView
      locale={locale}
      status={status}
      tasks={tasks}
      today={clock.day}
      nowTime={clock.time}
      pendingId={pendingId}
      tickedId={tickedId}
      reaction={reaction}
      errorKey={errorKey}
      remark={remark}
      expressions={expressions}
      artAvailable={artAvailable}
      reducedMotion={reducedMotion}
      messages={messages}
      now={now}
      onTick={(id) => void onTick(id)}
      onRetry={() => void load()}
      onAnswer={(q, v) => void onAnswer(q, v)}
    />
  );
}
