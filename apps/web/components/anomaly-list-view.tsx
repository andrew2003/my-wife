import type { AnomalyView } from "@my-wife/contracts";
import { translate, type Locale } from "../lib/i18n";
import { anomalyHref } from "../lib/receipt-confirmation";
import { ScreenState, stateKeys } from "./screen-state";

const ANOMALY_LIST_STATE_KEYS = stateKeys("anomalies");

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
  if (status === "loading")
    return <ScreenState locale={locale} kind="loading" keys={ANOMALY_LIST_STATE_KEYS} />;
  if (status === "empty")
    return <ScreenState locale={locale} kind="empty" keys={ANOMALY_LIST_STATE_KEYS} />;
  if (status === "error") {
    return (
      <ScreenState locale={locale} kind="error" keys={ANOMALY_LIST_STATE_KEYS} onRetry={onRetry} />
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
