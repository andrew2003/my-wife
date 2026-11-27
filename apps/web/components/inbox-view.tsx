import { QuestionStateSchema, SERVICE_NAMES } from "@my-wife/contracts";
import { canAnswer, isRead, type InboxFilter, type InboxItem } from "../lib/inbox";
import { translate, type Locale } from "../lib/i18n";

export type InboxStatus = "loading" | "ready" | "empty" | "error";

export interface InboxViewProps {
  locale: Locale;
  status: InboxStatus;
  items: InboxItem[];
  readIds: ReadonlySet<string>;
  now: Date;
  timeZone: string;
  filter: InboxFilter;
  /** Question currently being answered, so its buttons are disabled. */
  busyId: string | null;
  replyError: boolean;
  onFilter: (filter: InboxFilter) => void;
  onRefresh: () => void;
  onMarkRead: (itemId: string) => void;
  onAnswer: (questionId: string, value: string) => void;
}

/** Presentational inbox: messages with read state and question buttons. */
export function InboxView(props: InboxViewProps) {
  const { locale, status, items, readIds, now, timeZone, filter, busyId, replyError } = props;
  const t = (key: string, params?: Record<string, string | number>) =>
    translate(locale, key, params);
  const tag = locale === "vi" ? "vi-VN" : "en-US";
  const when = (iso: string) =>
    new Intl.DateTimeFormat(tag, { dateStyle: "medium", timeStyle: "short", timeZone }).format(
      new Date(iso),
    );
  const body = (item: InboxItem) => {
    const text = translate(locale, item.messageKey, item.params as Record<string, string | number>);
    return text === item.messageKey ? t("inbox.message_unavailable") : text;
  };

  const filters = (
    <div className="inbox-filters">
      <label>
        {t("inbox.filter.service")}
        <select
          value={filter.service ?? ""}
          onChange={(e) => props.onFilter({ ...filter, service: e.target.value || undefined })}
        >
          <option value="">{t("inbox.filter.all")}</option>
          {SERVICE_NAMES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t("inbox.filter.state")}
        <select
          value={filter.state ?? ""}
          onChange={(e) => {
            const parsed = QuestionStateSchema.safeParse(e.target.value);
            props.onFilter({ ...filter, state: parsed.success ? parsed.data : undefined });
          }}
        >
          <option value="">{t("inbox.filter.all")}</option>
          {QuestionStateSchema.options.map((s) => (
            <option key={s} value={s}>
              {t(`inbox.question.${s}`)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );

  if (status === "loading") return <p role="status">{t("inbox.loading")}</p>;
  if (status === "error") {
    return (
      <div>
        <p role="alert">{t("inbox.error")}</p>
        <button type="button" className="button" onClick={props.onRefresh}>
          {t("inbox.retry")}
        </button>
      </div>
    );
  }
  if (status === "empty") {
    return (
      <div>
        {filters}
        <p>{t("inbox.empty")}</p>
      </div>
    );
  }

  return (
    <div>
      <p>{t("inbox.intro")}</p>
      {filters}
      {replyError ? <p role="alert">{t("inbox.error.reply")}</p> : null}
      <ul className="penalty-list">
        {items.map((item) => {
          const read = isRead(item, readIds);
          const q = item.question;
          return (
            <li key={item.id} className="penalty-entry" data-read={read}>
              <p>
                <strong>{read ? t("inbox.state.read") : t("inbox.state.unread")}</strong>{" "}
                <span>{t(`inbox.class.${item.class}`)}</span>
                {q ? <span> {q.sourceService}</span> : null}
              </p>
              <p>{body(item)}</p>
              <p>{when(item.createdAt)}</p>
              {q ? (
                <div>
                  <p>{t(`inbox.question.${q.state}`)}</p>
                  {canAnswer(item, now) ? (
                    <div className="inbox-actions">
                      {q.options.map((o) => (
                        <button
                          key={o.value}
                          type="button"
                          className="button"
                          disabled={busyId === q.id}
                          onClick={() => props.onAnswer(q.id, o.value)}
                        >
                          {translate(locale, o.labelKey) === o.labelKey ? o.value : t(o.labelKey)}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {read ? null : (
                <button type="button" className="button" onClick={() => props.onMarkRead(item.id)}>
                  {t("inbox.mark_read")}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <button type="button" className="button" onClick={props.onRefresh}>
        {t("inbox.refresh")}
      </button>
    </div>
  );
}
