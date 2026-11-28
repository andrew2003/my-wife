import type { Task } from "@my-wife/contracts";
import { translate, type Locale } from "../lib/i18n";
import type { TaskAction } from "../lib/checklist";
import { TaskCountdown } from "./session-countdown";
import { ScreenState, stateKeys } from "./screen-state";

const CHECKLIST_STATE_KEYS = stateKeys("checklist");

export type ChecklistStatus = "loading" | "ready" | "error";

export interface ChecklistViewProps {
  locale: Locale;
  status: ChecklistStatus;
  tasks: Task[];
  /** Task whose action is being saved. */
  pendingId: string | null;
  /** Locale key of the last action error, if any. */
  errorKey: string | null;
  onAction: (action: TaskAction, taskId: string) => void;
  onRetry: () => void;
}

/** Presentational list of the day's tasks; state lives in the client wrapper. */
export function ChecklistView(props: ChecklistViewProps) {
  const { locale, status, tasks, pendingId, errorKey, onAction, onRetry } = props;
  const t = (key: string, params?: Record<string, string | number>) =>
    translate(locale, key, params);

  if (status === "loading") {
    return <ScreenState locale={locale} kind="loading" keys={CHECKLIST_STATE_KEYS} height="6rem" />;
  }
  if (status === "error") {
    return (
      <ScreenState locale={locale} kind="error" keys={CHECKLIST_STATE_KEYS} onRetry={onRetry} />
    );
  }
  if (tasks.length === 0) {
    return <ScreenState locale={locale} kind="empty" keys={CHECKLIST_STATE_KEYS} />;
  }
  return (
    <>
      {errorKey ? (
        <p role="alert" className="checklist-note">
          {t(errorKey)}
        </p>
      ) : null}
      <ul className="checklist">
        {tasks.map((task) => {
          const busy = pendingId === task.id;
          return (
            <li key={task.id} className={`checklist-item state-${task.state}`}>
              <div className="checklist-text">
                <span className="checklist-title">{task.title}</span>
                <span className="checklist-meta">
                  {task.window ? `${task.window.start}-${task.window.end} · ` : ""}
                  {t("checklist.minutes", { minutes: task.estimatedMinutes })}
                  {" · "}
                  {t(`checklist.state.${task.state}`)}
                </span>
              </div>
              <div className="checklist-actions">
                {task.state === "in_progress" ? (
                  <TaskCountdown locale={locale} taskId={task.id} />
                ) : null}
                {task.state === "planned" ? (
                  <button type="button" disabled={busy} onClick={() => onAction("start", task.id)}>
                    {t("checklist.start")}
                  </button>
                ) : null}
                {task.state === "planned" || task.state === "in_progress" ? (
                  <button type="button" disabled={busy} onClick={() => onAction("done", task.id)}>
                    {t("checklist.done")}
                  </button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
