import { QuestionStateSchema, SERVICE_NAMES } from "@my-wife/contracts";
import type { ExpressionSettings } from "../lib/expressions";
import { canAnswer, inboxStickerKey, isRead, type InboxFilter, type InboxItem } from "../lib/inbox";
import { translate, type Locale } from "../lib/i18n";
import { Mascot } from "./mascot";
import { Button, EmptyState, ErrorState, Skeleton } from "./ui";

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
  /** The active sticker set and the user's mapping of states to expressions. */
  expressions: ExpressionSettings;
  artAvailable: boolean;
  /** Values sent from this screen, by question id, so a sent answer shows at once. */
  answers?: Record<string, string>;
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

  const label = (labelKey: string, value: string) =>
    translate(locale, labelKey) === labelKey ? value : t(labelKey);
  const art = (
    <Mascot
      artKey="chibi-greet"
      size="medium"
      alt={t("inbox.sticker_alt")}
      available={props.artAvailable}
    />
  );

  if (status === "loading") {
    return (
      <div className="inbox-thread" aria-busy="true">
        <Skeleton label={t("inbox.loading")} height="4rem" />
        <Skeleton label={t("inbox.loading")} height="4rem" />
        <Skeleton label={t("inbox.loading")} height="4rem" />
      </div>
    );
  }
  if (status === "error") {
    return (
      <ErrorState
        title={t("inbox.error.title")}
        description={t("inbox.error")}
        art={art}
        retryLabel={t("inbox.retry")}
        onRetry={props.onRefresh}
      />
    );
  }
  if (status === "empty") {
    return (
      <div>
        {filters}
        <EmptyState title={t("inbox.empty")} art={art} />
      </div>
    );
  }

  return (
    <div>
      <p>{t("inbox.intro")}</p>
      {filters}
      {replyError ? <p role="alert">{t("inbox.error.reply")}</p> : null}
      <ul className="inbox-thread">
        {items.map((item) => {
          const read = isRead(item, readIds);
          const q = item.question;
          const sent = q ? props.answers?.[q.id] : undefined;
          return (
            <li key={item.id} className="inbox-message" data-read={read}>
              <div className="inbox-sticker">
                <Mascot
                  artKey={inboxStickerKey(item, now, props.expressions)}
                  size="small"
                  alt={t("inbox.sticker_alt")}
                  available={props.artAvailable}
                />
              </div>
              <div className="inbox-bubble">
                <p className="inbox-meta">
                  <strong>{read ? t("inbox.state.read") : t("inbox.state.unread")}</strong>{" "}
                  <span>{t(`inbox.class.${item.class}`)}</span>
                  {q ? <span> {q.sourceService}</span> : null}
                </p>
                <p>{body(item)}</p>
                <p className="inbox-meta">{when(item.createdAt)}</p>
                {q ? (
                  <div>
                    <p>{t(`inbox.question.${q.state}`)}</p>
                    {sent !== undefined ? (
                      <p>
                        {t("inbox.your_answer", {
                          value: label(
                            q.options.find((o) => o.value === sent)?.labelKey ?? "",
                            sent,
                          ),
                        })}
                      </p>
                    ) : null}
                    {canAnswer(item, now) ? (
                      <div className="inbox-actions">
                        {q.options.map((o) => (
                          <button
                            key={o.value}
                            type="button"
                            className="mw-chip-button"
                            data-answer-option
                            disabled={busyId === q.id}
                            onClick={() => props.onAnswer(q.id, o.value)}
                          >
                            {label(o.labelKey, o.value)}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {read ? null : (
                  <Button onClick={() => props.onMarkRead(item.id)}>{t("inbox.mark_read")}</Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <Button onClick={props.onRefresh}>{t("inbox.refresh")}</Button>
    </div>
  );
}
