import type { PenaltyLedgerEntry } from "@my-wife/contracts";
import { translate, type Locale } from "../lib/i18n";
import { canAppeal } from "../lib/penalty-ledger";

export type LedgerStatus = "loading" | "ready" | "empty" | "error";
export type AppealState = "idle" | "sending" | "sent" | "failed";

export interface PenaltyLedgerViewProps {
  locale: Locale;
  status: LedgerStatus;
  penalties: PenaltyLedgerEntry[];
  timeZone: string;
  appealingId: string | null;
  appealState: AppealState;
  onAppeal: (id: string) => void;
  onCancelAppeal: () => void;
  onSubmitAppeal: (id: string, reason: string) => void;
  onRefresh: () => void;
}

/** Presentational penalty ledger with an appeal form; state lives in the client wrapper. */
export function PenaltyLedgerView(props: PenaltyLedgerViewProps) {
  const { locale, status, penalties, timeZone, appealingId, appealState } = props;
  const t = (key: string, params?: Record<string, string | number>) =>
    translate(locale, key, params);
  const tag = locale === "vi" ? "vi-VN" : "en-US";
  const money = (vnd: number) =>
    `${new Intl.NumberFormat(tag).format(vnd)} ${t("penalty.currency")}`;
  const when = (iso: string) =>
    new Intl.DateTimeFormat(tag, { dateStyle: "medium", timeZone }).format(new Date(iso));

  if (status === "loading") return <p role="status">{t("penalty.loading")}</p>;
  if (status === "empty") return <p>{t("penalty.empty")}</p>;
  if (status === "error") {
    return (
      <div>
        <p role="alert">{t("penalty.error")}</p>
        <button type="button" className="button" onClick={props.onRefresh}>
          {t("penalty.retry")}
        </button>
      </div>
    );
  }

  return (
    <section aria-label={t("penalty.title")}>
      <p>{t("penalty.intro")}</p>
      <ul className="penalty-list">
        {penalties.map((p) => (
          <li key={p.id} className="penalty-entry">
            <p>
              <strong>{money(p.amountVnd)}</strong> <span>{t(`penalty.status.${p.status}`)}</span>
            </p>
            <p>
              {t("penalty.source")} {t(`penalty.source.${p.source}`)}
            </p>
            {p.dueDate ? (
              <p>
                {t("penalty.due")} {when(p.dueDate)}
              </p>
            ) : null}
            <p>
              {t("penalty.code")} <code>{p.transferCode}</code>
            </p>
            {canAppeal(p.status) && appealingId !== p.id ? (
              <button type="button" className="button" onClick={() => props.onAppeal(p.id)}>
                {t("penalty.appeal.action")}
              </button>
            ) : null}
            {appealingId === p.id ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const data = new FormData(e.currentTarget);
                  props.onSubmitAppeal(p.id, String(data.get("reason") ?? ""));
                }}
              >
                <label>
                  {t("penalty.appeal.reason")}
                  <textarea name="reason" required rows={3} />
                </label>
                {appealState === "failed" ? <p role="alert">{t("penalty.appeal.failed")}</p> : null}
                <button type="submit" className="button" disabled={appealState === "sending"}>
                  {t("penalty.appeal.submit")}
                </button>
                <button type="button" className="button" onClick={props.onCancelAppeal}>
                  {t("penalty.appeal.cancel")}
                </button>
              </form>
            ) : null}
          </li>
        ))}
      </ul>
      {appealState === "sent" ? <p role="status">{t("penalty.appeal.sent")}</p> : null}
      <button type="button" className="button" onClick={props.onRefresh}>
        {t("penalty.refresh")}
      </button>
    </section>
  );
}
