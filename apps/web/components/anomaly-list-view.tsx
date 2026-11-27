import type { AnomalyView } from "@my-wife/contracts";
import { translate, type Locale } from "../lib/i18n";
import { anomalyHref } from "../lib/receipt-confirmation";

export type AnomalyListStatus = "loading" | "ready" | "empty" | "error";

export interface AnomalyListViewProps {
  locale: Locale;
  status: AnomalyListStatus;
  anomalies: AnomalyView[];
  onRetry: () => void;
}

/** The anomaly inbox; receipt anomalies open the confirmation screen. */
export function AnomalyListView({ locale, status, anomalies, onRetry }: AnomalyListViewProps) {
  const t = (key: string) => translate(locale, key);
  if (status === "loading") return <p role="status">{t("anomalies.loading")}</p>;
  if (status === "empty") return <p>{t("anomalies.empty")}</p>;
  if (status === "error") {
    return (
      <div>
        <p role="alert">{t("anomalies.error")}</p>
        <button type="button" className="button" onClick={onRetry}>
          {t("anomalies.retry")}
        </button>
      </div>
    );
  }
  return (
    <div>
      <p>{t("anomalies.intro")}</p>
      <ul className="penalty-list">
        {anomalies.map((a) => {
          const href = anomalyHref(a);
          const label = t(`budget.anomaly.${a.kind}`);
          return (
            <li key={a.id} className="penalty-entry">
              {href ? <a href={href}>{label}</a> : <span>{label}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
