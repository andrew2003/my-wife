import { translate, type Locale } from "../lib/i18n";
import type { BudgetPreview } from "../lib/onboarding";

export interface ContractSigningViewProps {
  locale: Locale;
  budget: BudgetPreview;
  agreed: boolean;
  busy: boolean;
  /** Locale key of the last error, if any. */
  errorKey: string | null;
  onAgreeChange: (agreed: boolean) => void;
  onSign: () => void;
}

/** Last onboarding step: a summary of the commitment contract and the Sign button. */
export function ContractSigningView(props: ContractSigningViewProps) {
  const { locale, budget, agreed, busy, errorKey } = props;
  const t = (key: string, params?: Record<string, string | number>) =>
    translate(locale, key, params);
  const money = new Intl.NumberFormat(locale === "vi" ? "vi-VN" : "en-US");

  return (
    <section className="contract" aria-label={t("contract.title")}>
      <h2>{t("contract.title")}</h2>
      <p>{t("contract.intro")}</p>
      {errorKey ? <p role="alert">{t(errorKey)}</p> : null}
      <ul>
        <li>
          <strong>{t("contract.item.budget")}</strong>{" "}
          {t("onboarding.review.cycle", {
            weeks: budget.cycle.weeks,
            firstDay: budget.cycle.firstDay,
          })}
          {budget.categories.length === 0 ? (
            <p>{t("onboarding.review.budget_empty")}</p>
          ) : (
            <ul>
              {budget.categories.map((c) => (
                <li key={c.id}>
                  {c.name} {money.format(c.cycleLimitVnd)} {t("onboarding.review.currency")}
                </li>
              ))}
            </ul>
          )}
        </li>
        <li>
          <strong>{t("contract.item.supervision")}</strong> {t("contract.item.supervision_text")}
        </li>
        <li>
          <strong>{t("contract.item.penalties")}</strong> {t("contract.item.penalties_text")}
        </li>
        <li>
          <strong>{t("contract.item.trial")}</strong> {t("contract.item.trial_text")}
        </li>
      </ul>
      <p>{t("contract.loosening")}</p>
      <label className="onboarding-field">
        <input
          type="checkbox"
          checked={agreed}
          disabled={busy}
          onChange={(e) => props.onAgreeChange(e.target.checked)}
        />{" "}
        <span>{t("contract.agree")}</span>
      </label>
      {busy ? <p role="status">{t("contract.signing")}</p> : null}
      <div className="onboarding-actions">
        <button type="button" className="button" disabled={!agreed || busy} onClick={props.onSign}>
          {t("contract.sign")}
        </button>
      </div>
    </section>
  );
}
