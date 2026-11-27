import type { Debt } from "@my-wife/contracts";
import { remainingVnd, splitDebts } from "../lib/debts";
import { translate, type Locale } from "../lib/i18n";

export type DebtsStatus = "loading" | "ready" | "empty" | "error";

export interface DebtsViewProps {
  locale: Locale;
  status: DebtsStatus;
  debts: Debt[];
  timeZone: string;
  onRefresh: () => void;
}

/** Presentational list of open payables and receivables with due dates. */
export function DebtsView({ locale, status, debts, timeZone, onRefresh }: DebtsViewProps) {
  const t = (key: string) => translate(locale, key);
  const tag = locale === "vi" ? "vi-VN" : "en-US";
  const money = (vnd: number) => `${new Intl.NumberFormat(tag).format(vnd)} ${t("debts.currency")}`;
  const when = (iso: string) =>
    new Intl.DateTimeFormat(tag, { dateStyle: "medium", timeZone }).format(new Date(iso));

  if (status === "loading") return <p role="status">{t("debts.loading")}</p>;
  if (status === "empty") return <p>{t("debts.empty")}</p>;
  if (status === "error") {
    return (
      <div>
        <p role="alert">{t("debts.error")}</p>
        <button type="button" className="button" onClick={onRefresh}>
          {t("debts.retry")}
        </button>
      </div>
    );
  }

  const { payables, receivables } = splitDebts(debts);
  const group = (title: string, none: string, list: Debt[]) => (
    <section aria-label={title}>
      <h2>{title}</h2>
      {list.length === 0 ? (
        <p>{none}</p>
      ) : (
        <ul className="penalty-list">
          {list.map((d) => (
            <li key={d.id} className="penalty-entry">
              <p>
                <strong>{d.person}</strong> <span>{t(`debts.state.${d.state}`)}</span>
              </p>
              <p>
                {t("debts.remaining")} {money(remainingVnd(d))} / {money(d.amountVnd)}
              </p>
              <p>
                {t("debts.due")} {d.dueAt ? when(d.dueAt) : t("debts.no_due_date")}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  return (
    <div>
      <p>{t("debts.intro")}</p>
      {group(t("debts.payables"), t("debts.none_payables"), payables)}
      {group(t("debts.receivables"), t("debts.none_receivables"), receivables)}
      <button type="button" className="button" onClick={onRefresh}>
        {t("debts.refresh")}
      </button>
    </div>
  );
}
