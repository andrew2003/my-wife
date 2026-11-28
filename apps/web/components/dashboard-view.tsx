import type { Task } from "@my-wife/contracts";
import {
  dashboardProgress,
  taskChipState,
  type DashboardReaction,
  type TaskChipState,
} from "../lib/dashboard";
import { resolveExpression, type ExpressionSettings } from "../lib/expressions";
import { translate, type Locale } from "../lib/i18n";
import { canAnswer, inboxStickerKey, type InboxItem } from "../lib/inbox";
import { Mascot } from "./mascot";
import { SpeechBubble } from "./speech-bubble";
import { Chip, EmptyState, ErrorState, ProgressBar, Skeleton } from "./ui";

export type DashboardStatus = "loading" | "ready" | "error";

export type DashboardRemark =
  { status: "loading" } | { status: "ready"; text: string } | { status: "error" };

export type DashboardMessages =
  | { status: "loading" }
  | { status: "empty" }
  | { status: "error" }
  | { status: "ready"; items: InboxItem[] };

export interface DashboardViewProps {
  locale: Locale;
  status: DashboardStatus;
  tasks: Task[];
  /** User-zone date and time, passed in so the view never reads the clock. */
  today: string;
  nowTime: string;
  pendingId: string | null;
  /** Task that was just ticked: it plays the check pop and the sparkle burst. */
  tickedId: string | null;
  reaction: DashboardReaction | null;
  errorKey: string | null;
  remark: DashboardRemark;
  expressions: ExpressionSettings;
  artAvailable: boolean;
  /** True when the user prefers reduced motion: no animation class is rendered at all. */
  reducedMotion: boolean;
  messages: DashboardMessages;
  now?: Date;
  onTick: (taskId: string) => void;
  onRetry: () => void;
  onAnswer?: (questionId: string, value: string) => void;
}

const CHIP_TONE: Record<TaskChipState, "success" | "neutral" | "warning"> = {
  done: "success",
  upcoming: "neutral",
  not_done: "warning",
};

/** Presentational dashboard: character, checklist with progress, and the messages card. */
export function DashboardView(props: DashboardViewProps) {
  const { locale, status, tasks, today, nowTime, reducedMotion, reaction, tickedId } = props;
  const t = (key: string, params?: Record<string, string | number>) =>
    translate(locale, key, params);
  // One switch: with reduced motion no animation class is emitted, whatever the CSS says.
  const motion = (cls: string) => (reducedMotion ? "" : ` ${cls}`);
  const progress = dashboardProgress(tasks);

  const bubbleText =
    props.remark.status === "ready"
      ? props.remark.text
      : props.remark.status === "error"
        ? t("companion.fallback")
        : undefined;
  const mascotState = reaction ? reaction.state : "greeting";
  const mascotKey = resolveExpression(props.expressions, mascotState);

  const character = (
    <section className="dash-hero" aria-label={t("dashboard.character_label")}>
      <SpeechBubble
        {...(bubbleText ? { text: bubbleText } : {})}
        typingLabel={t("companion.loading")}
      />
      <div className={`dash-stage${motion("halo")}`}>
        <div
          className={`dash-mascot${motion("mascot-float")}${tickedId ? motion("mascot-hop") : ""}`}
        >
          <Mascot
            artKey={mascotKey}
            size="large"
            alt={t("companion.art_alt")}
            available={props.artAvailable}
          />
        </div>
        <span className={`dash-shadow${motion("shadow-breathe")}`} aria-hidden="true" />
      </div>
      <div className="dash-reaction" role="status" aria-live="polite">
        {reaction ? (
          <>
            <span className="dash-reaction-sticker" aria-hidden="true">
              <Mascot
                artKey={resolveExpression(props.expressions, reaction.state)}
                size="small"
                alt=""
                available={props.artAvailable}
              />
            </span>
            <span>{reaction.text}</span>
          </>
        ) : null}
      </div>
    </section>
  );

  let checklist;
  if (status === "loading") {
    checklist = <Skeleton label={t("dashboard.loading")} height="9rem" />;
  } else if (status === "error") {
    checklist = (
      <ErrorState
        title={t("dashboard.error.title")}
        description={t("dashboard.error.description")}
        retryLabel={t("checklist.retry")}
        onRetry={props.onRetry}
      />
    );
  } else if (tasks.length === 0) {
    checklist = (
      <EmptyState
        title={t("dashboard.empty.title")}
        description={t("dashboard.empty.description")}
      />
    );
  } else {
    checklist = (
      <>
        <ProgressBar
          value={progress.percent}
          label={t("dashboard.progress", { done: progress.done, total: progress.total })}
        />
        {props.errorKey ? (
          <p role="alert" className="checklist-note">
            {t(props.errorKey)}
          </p>
        ) : null}
        <ul className="dash-list">
          {tasks.map((task) => {
            const chip = taskChipState(task, today, nowTime);
            const ticked = tickedId === task.id;
            const canTick = task.state === "planned" || task.state === "in_progress";
            return (
              <li
                key={task.id}
                className={`dash-row chip-${chip}${chip === "not_done" && task.state !== "skipped" ? motion("dash-wobble") : ""}`}
              >
                <button
                  type="button"
                  className="dash-tick"
                  disabled={!canTick || props.pendingId === task.id}
                  aria-pressed={task.state === "done"}
                  aria-label={t("dashboard.tick_label", { title: task.title })}
                  onClick={() => props.onTick(task.id)}
                >
                  <span
                    className={`dash-check${ticked ? motion("check-pop") : ""}`}
                    aria-hidden="true"
                  >
                    {task.state === "done" ? "✓" : ""}
                  </span>
                  {ticked && !reducedMotion ? (
                    <span className={`dash-sparkles sparkle`} aria-hidden="true">
                      <i />
                      <i />
                      <i />
                      <i />
                    </span>
                  ) : null}
                </button>
                <span className="dash-row-text">
                  <span className={`dash-title${task.state === "done" ? " is-done" : ""}`}>
                    {task.title}
                  </span>
                  <span className="dash-time">
                    {task.window
                      ? `${task.window.start}-${task.window.end}`
                      : t("dashboard.any_time")}
                  </span>
                </span>
                <Chip tone={CHIP_TONE[chip]}>{t(`dashboard.chip.${chip}`)}</Chip>
              </li>
            );
          })}
        </ul>
      </>
    );
  }

  return (
    <div className="dashboard" data-motion={reducedMotion ? "off" : "on"}>
      <h1 className="dash-title-main">{t("home.title")}</h1>
      <div className="dash-grid">
        <section className="dash-card dash-checklist" aria-label={t("checklist.title")}>
          <h2>{t("checklist.title")}</h2>
          {checklist}
        </section>
        {character}
        <section className="dash-card dash-messages" aria-label={t("dashboard.messages.title")}>
          <h2>{t("dashboard.messages.title")}</h2>
          <MessagesCard {...props} />
        </section>
      </div>
    </div>
  );
}

function MessagesCard(props: DashboardViewProps) {
  const { locale, messages } = props;
  const t = (key: string, params?: Record<string, string | number>) =>
    translate(locale, key, params);
  const now = props.now ?? new Date(0);
  if (messages.status === "loading")
    return <Skeleton label={t("dashboard.loading")} height="5rem" />;
  if (messages.status === "error")
    return <p className="mw-hint">{t("dashboard.messages.error")}</p>;
  if (messages.status === "empty")
    return <p className="mw-hint">{t("dashboard.messages.empty")}</p>;
  return (
    <>
      <ul className="dash-messages-list">
        {messages.items.slice(0, 3).map((item) => {
          const text = translate(
            locale,
            item.messageKey,
            item.params as Record<string, string | number>,
          );
          const q = item.question;
          return (
            <li key={item.id}>
              <span className="dash-message-sticker" aria-hidden="true">
                <Mascot
                  artKey={inboxStickerKey(item, now, props.expressions)}
                  size="small"
                  alt=""
                  available={props.artAvailable}
                />
              </span>
              <div>
                <p>{text === item.messageKey ? t("inbox.message_unavailable") : text}</p>
                {q && props.onAnswer && canAnswer(item, now) ? (
                  <div className="dash-chips">
                    {q.options.map((o) => (
                      <Chip key={o.value} onClick={() => props.onAnswer?.(q.id, o.value)}>
                        {translate(locale, o.labelKey) === o.labelKey
                          ? o.value
                          : translate(locale, o.labelKey)}
                      </Chip>
                    ))}
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      <a href="/inbox">{t("dashboard.messages.open")}</a>
    </>
  );
}
