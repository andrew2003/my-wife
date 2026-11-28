import type { ContractPageData } from "../lib/contract-page";
import { translate, type Locale } from "../lib/i18n";
import { ScreenState, stateKeys } from "./screen-state";

const CONTRACT_PAGE_STATE_KEYS = stateKeys("contract.page");

export type ContractPageStatus = "loading" | "ready" | "empty" | "error";
export type SignState = "idle" | "sending" | "failed";

export interface ContractPageViewProps {
  locale: Locale;
  status: ContractPageStatus;
  data: ContractPageData | null;
  timeZone: string;
  agreed: boolean;
  signState: SignState;
  onAgreeChange: (agreed: boolean) => void;
  onSign: () => void;
  onRefresh: () => void;
}

/** Presentational contract and reward page; state lives in the client wrapper. */
export function ContractPageView(props: ContractPageViewProps) {
  const { locale, status, data, timeZone, agreed, signState } = props;
  const t = (key: string, params?: Record<string, string | number>) =>
    translate(locale, key, params);
  const tag = locale === "vi" ? "vi-VN" : "en-US";
  const money = (vnd: number) =>
    `${new Intl.NumberFormat(tag).format(vnd)} ${t("penalty.currency")}`;
  const when = (iso: string) =>
    new Intl.DateTimeFormat(tag, { dateStyle: "medium", timeZone }).format(new Date(iso));

  if (status === "loading")
    return <ScreenState locale={locale} kind="loading" keys={CONTRACT_PAGE_STATE_KEYS} />;
  if (status === "empty" || !data)
    return <ScreenState locale={locale} kind="empty" keys={CONTRACT_PAGE_STATE_KEYS} />;
  if (status === "error") {
    return (
      <ScreenState
        locale={locale}
        kind="error"
        keys={CONTRACT_PAGE_STATE_KEYS}
        onRetry={props.onRefresh}
      />
    );
  }

  const busy = signState === "sending";
  return (
    <>
      <section className="contract" aria-label={t("contract.title")}>
        <h2>{t("contract.title")}</h2>
        {data.contractRequired ? (
          <>
            <p>{t("contract.intro")}</p>
            <ul>
              <li>
                <strong>{t("contract.item.supervision")}</strong>{" "}
                {t("contract.item.supervision_text")}
              </li>
              <li>
                <strong>{t("contract.item.penalties")}</strong> {t("contract.item.penalties_text")}
              </li>
            </ul>
            <p>{t("contract.loosening")}</p>
            {signState === "failed" ? <p role="alert">{t("contract.error.sign")}</p> : null}
            <label>
              <input
                type="checkbox"
                checked={agreed}
                disabled={busy}
                onChange={(e) => props.onAgreeChange(e.target.checked)}
              />{" "}
              <span>{t("contract.agree")}</span>
            </label>
            {busy ? <p role="status">{t("contract.signing")}</p> : null}
            <button
              type="button"
              className="button"
              disabled={!agreed || busy}
              onClick={props.onSign}
            >
              {t("contract.sign")}
            </button>
          </>
        ) : (
          <p>{t("contract.page.signed")}</p>
        )}
        {data.looseningLockedUntil ? (
          <p>{t("contract.page.locked_until", { date: when(data.looseningLockedUntil) })}</p>
        ) : null}
      </section>
      <section className="rewards" aria-label={t("contract.page.rewards")}>
        <h2>{t("contract.page.rewards")}</h2>
        <p>
          {t("contract.page.rule", {
            days: data.rule.streakDays,
            amount: money(data.rule.amountVnd),
          })}
        </p>
        {data.rewards.length === 0 ? (
          <p>{t("contract.page.rewards_empty")}</p>
        ) : (
          <ul>
            {data.rewards.map((r) => (
              <li key={r.id}>
                <strong>{money(r.amountVnd)}</strong> {when(r.unlockedAt)}{" "}
                {r.categoryId === null
                  ? t("contract.page.reward_fund")
                  : t("contract.page.reward_category")}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
