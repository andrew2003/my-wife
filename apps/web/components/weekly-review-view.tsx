import { translate, type Locale } from "../lib/i18n";
import type { Review } from "../lib/weekly-review";

export type WeeklyReviewStatus = "loading" | "ready" | "not_ready" | "empty" | "error";

export interface WeeklyReviewViewProps {
  locale: Locale;
  status: WeeklyReviewStatus;
  review: Review | null;
  /** Suggestion kinds the user already accepted. */
  accepted: string[];
  busy: boolean;
  errorKey: string | null;
  onAccept: (kind: string) => void;
  onRetry: () => void;
}

/** Presentational weekly review: tasks, faults, spending and suggestions with accept buttons. */
export function WeeklyReviewView(props: WeeklyReviewViewProps) {
  const { locale, status, review, accepted, busy, errorKey } = props;
  const t = (key: string, params?: Record<string, string | number>) =>
    translate(locale, key, params);

  if (status === "loading") return <p role="status">{t("review.loading")}</p>;
  if (status === "empty") return <p>{t("review.empty")}</p>;
  if (status === "not_ready") return <p>{t("review.not_ready")}</p>;
  if (status === "error" || !review) {
    return (
      <div role="alert">
        <p>{t("review.error")}</p>
        <button type="button" className="button" onClick={props.onRetry}>
          {t("review.retry")}
        </button>
      </div>
    );
  }

  const tag = locale === "vi" ? "vi-VN" : "en-US";
  const money = (vnd: number) =>
    `${new Intl.NumberFormat(tag).format(vnd)} ${t("review.currency")}`;
  const minutes = (m: number) => t("review.minutes", { minutes: m });
  const date = (iso: string) =>
    new Intl.DateTimeFormat(tag, { day: "numeric", month: "short", timeZone: "UTC" }).format(
      new Date(iso.length === 10 ? `${iso}T00:00:00.000Z` : iso),
    );

  return (
    <div>
      <p>{t("review.week_of", { date: date(review.firstDay) })}</p>
      {errorKey ? <p role="alert">{t(errorKey)}</p> : null}

      <section aria-labelledby="review-tasks">
        <h2 id="review-tasks">{t("review.tasks.title")}</h2>
        <p>
          {t("review.tasks.summary", {
            completed: review.tasks.completed,
            planned: review.tasks.planned,
            carried: review.tasks.carried,
            open: review.tasks.open,
          })}
        </p>
        {review.estimates.measured > 0 ? (
          <p>
            {t("review.tasks.estimates", {
              estimated: minutes(review.estimates.estimatedMinutes),
              actual: minutes(review.estimates.actualMinutes),
              overran: review.estimates.overran,
            })}
          </p>
        ) : null}
        {review.tasks.completedTasks.length === 0 ? (
          <p>{t("review.tasks.none")}</p>
        ) : (
          <ul>
            {review.tasks.completedTasks.map((task) => (
              <li key={task.id}>
                {task.title} <span>{date(task.day)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="review-faults">
        <h2 id="review-faults">{t("review.faults.title")}</h2>
        {review.faults.items.length === 0 ? (
          <p>{t("review.faults.none")}</p>
        ) : (
          <>
            <p>{t("review.faults.total", { points: review.faults.totalPoints })}</p>
            <ul>
              {review.faults.items.map((f) => (
                <li key={f.faultId}>
                  {t(`fault.type.${f.type}`)} <span>{date(f.occurredAt)}</span>{" "}
                  <span>{t("review.faults.points", { points: f.points })}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section aria-labelledby="review-spend">
        <h2 id="review-spend">{t("review.spend.title")}</h2>
        <p>{t("review.spend.spent", { amount: money(review.spending.spentVnd) })}</p>
        <p>
          {review.spending.overspentExcessVnd > 0
            ? t("review.spend.over", { amount: money(review.spending.overspentExcessVnd) })
            : t("review.spend.within")}
        </p>
      </section>

      <section aria-labelledby="review-suggestions">
        <h2 id="review-suggestions">{t("review.suggestions.title")}</h2>
        {review.suggestions.length === 0 ? (
          <p>{t("review.suggestions.none")}</p>
        ) : (
          review.suggestions.map((s) => (
            <div key={s.kind}>
              <p>{t("review.suggestions.adjust_durations", { count: s.overranCount })}</p>
              <p>{t("review.suggestions.informational")}</p>
              <ul>
                {s.tasks.map((task) => (
                  <li key={task.taskId}>
                    {task.title}:{" "}
                    {t("review.suggestions.change", {
                      from: minutes(task.estimatedMinutes),
                      to: minutes(task.suggestedMinutes),
                    })}
                  </li>
                ))}
              </ul>
              {accepted.includes(s.kind) ? (
                <p role="status">{t("review.accepted")}</p>
              ) : (
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => props.onAccept(s.kind)}
                >
                  {t("review.accept")}
                </button>
              )}
            </div>
          ))
        )}
      </section>
    </div>
  );
}
