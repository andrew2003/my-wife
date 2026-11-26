import { translate, type Locale } from "../lib/i18n";
import { buildTransferQrPayload, qrDataUrl, type FundingAccount } from "../lib/funding";

export type FundingStatus = "loading" | "ready" | "empty" | "error";

export interface FundingViewProps {
  locale: Locale;
  status: FundingStatus;
  accounts: FundingAccount[];
  onRefresh: () => void;
}

/** Presentational transfer list of the cycle; state and polling live in the client wrapper. */
export function FundingView({ locale, status, accounts, onRefresh }: FundingViewProps) {
  const t = (key: string, params?: Record<string, string | number>) =>
    translate(locale, key, params);
  const money = new Intl.NumberFormat(locale === "vi" ? "vi-VN" : "en-US");

  if (status === "loading") return <p role="status">{t("funding.loading")}</p>;
  if (status === "empty") return <p>{t("funding.empty")}</p>;
  if (status === "error") {
    return (
      <div>
        <p role="alert">{t("funding.error")}</p>
        <button type="button" className="button" onClick={onRefresh}>
          {t("funding.retry")}
        </button>
      </div>
    );
  }

  const allFunded = accounts.every((a) => a.funded);
  return (
    <section aria-label={t("funding.title")}>
      <p>{t("funding.intro")}</p>
      {allFunded ? <p role="status">{t("funding.all_funded")}</p> : null}
      <ul className="funding-list">
        {accounts.map((a) => (
          <li key={a.bankAccountId} className="funding-account">
            <h2>{a.name}</h2>
            <p>
              <strong>{t("funding.amount")}</strong> {money.format(a.requiredVnd)}{" "}
              {t("funding.currency")}
            </p>
            <p>
              <strong>{t("funding.code")}</strong> <code>{a.memo}</code>
            </p>
            <p role="status">
              {a.funded ? t("funding.status.funded") : t("funding.status.waiting")}
            </p>
            {a.funded ? null : (
              <img
                className="funding-qr"
                width={180}
                height={180}
                src={qrDataUrl(buildTransferQrPayload(a))}
                alt={t("funding.qr_alt", { name: a.name })}
              />
            )}
          </li>
        ))}
      </ul>
      <button type="button" className="button" onClick={onRefresh}>
        {t("funding.refresh")}
      </button>
    </section>
  );
}
