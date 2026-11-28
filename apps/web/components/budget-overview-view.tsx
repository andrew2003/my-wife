import type { PenaltyLedgerEntry } from "@my-wife/contracts";
import type { Overview, PenaltiesResult } from "../lib/budget-overview";
import type { FundingResult } from "../lib/funding";
import { translate, type Locale } from "../lib/i18n";

export type OverviewStatus = "loading" | "ready" | "empty" | "error";

export interface BudgetOverviewViewProps {
  locale: Locale;
  status: OverviewStatus;
  overview: Overview | null;
  penalties: PenaltiesResult;
  /** Transfer list of the cycle; the section is hidden while it is not provided. */
  transfers?: FundingResult;
  /** IANA zone of the user's `calendar.time_zone`; dates are shown in it. */
  timeZone: string;
  onRefresh: () => void;
}

/** Presentational budget page; loading and refreshing live in the client wrapper. */
export function BudgetOverviewView({
  locale,
  status,
  overview,
  penalties,
  transfers,
  timeZone,
  onRefresh,
}: BudgetOverviewViewProps) {
  const t = (key: string, params?: Record<string, string | number>) =>
    translate(locale, key, params);
  const money = (vnd: number) =>
    `${new Intl.NumberFormat(locale === "vi" ? "vi-VN" : "en-US").format(vnd)} ${t("budget.currency")}`;
  const when = (iso: string) =>
    new Intl.DateTimeFormat(locale === "vi" ? "vi-VN" : "en-US", {
      dateStyle: "medium",
      timeZone,
    }).format(new Date(iso));

  if (status === "loading") return <p role="status">{t("budget.loading")}</p>;
  if (status === "error") {
    return (
      <div>
        <p role="alert">{t("budget.error")}</p>
        <button type="button" className="button" onClick={onRefresh}>
          {t("budget.retry")}
        </button>
      </div>
    );
  }

  if (status === "empty" || !overview) return <p>{t("budget.empty")}</p>;

  const names = new Map(overview.categories.map((c) => [c.category.id, c.category.name]));
  const penaltyAccount = overview.bankAccounts.find((a) => a.kind === "penalty_savings");

  const penaltyCard = (p: PenaltyLedgerEntry) => (
    <li key={p.id} className="budget-penalty">
      <p>
        <strong>{t("budget.penalty.amount")}</strong> {money(p.amountVnd)}
      </p>
      {p.dueDate ? (
        <p>
          <strong>{t("budget.penalty.due")}</strong> {when(p.dueDate)}
        </p>
      ) : null}
      <p>
        <strong>{t("budget.penalty.code")}</strong> <code>{p.transferCode}</code>
      </p>
      {penaltyAccount ? (
        <p>
          <strong>{t("budget.penalty.account")}</strong> {penaltyAccount.name} (
          {penaltyAccount.code})
        </p>
      ) : null}
      <p>{t("budget.penalty.instructions")}</p>
    </li>
  );

  return (
    <div>
      <p>{t("budget.week", { week: overview.weekIndex, weeks: overview.cycle.weeks })}</p>

      {penalties.status === "error" ? (
        <p role="alert">{t("budget.penalty.error")}</p>
      ) : penalties.status === "ready" && penalties.due.length > 0 ? (
        <section aria-label={t("budget.penalty.title")}>
          <h2>{t("budget.penalty.title")}</h2>
          <ul className="budget-list">{penalties.due.map(penaltyCard)}</ul>
        </section>
      ) : null}

      {transfers ? (
        <section aria-label={t("budget.transfers.title")}>
          <h2>{t("budget.transfers.title")}</h2>
          {transfers.status === "error" ? (
            <p role="alert">{t("budget.transfers.error")}</p>
          ) : transfers.status === "ready" && transfers.accounts.length > 0 ? (
            <ul className="budget-list">
              {transfers.accounts.map((a) => (
                <li key={a.bankAccountId} className="budget-transfer">
                  <p>
                    <strong>{a.name}</strong> ({a.code}) {money(a.requiredVnd)}
                  </p>
                  <p>
                    <strong>{t("funding.code")}</strong> <code>{a.memo}</code>
                  </p>
                  <p>{a.funded ? t("funding.status.funded") : t("funding.status.waiting")}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p>{t("budget.transfers.empty")}</p>
          )}
          <a className="button" href="/budget/funding">
            {t("budget.transfers.open")}
          </a>
        </section>
      ) : null}

      <section aria-label={t("budget.categories.title")}>
        <h2>{t("budget.categories.title")}</h2>
        {overview.categories.length === 0 ? (
          <p>{t("budget.categories.empty")}</p>
        ) : (
          <ul className="budget-list">
            {overview.categories.map((c) => (
              <li key={c.category.id} className="budget-category">
                <h3>
                  {c.category.name} <small>{t(`budget.priority.${c.category.priority}`)}</small>
                </h3>
                <p>
                  <strong>{t("budget.remaining")}</strong> {money(c.remainingVnd)}
                </p>
                <p>
                  {t("budget.spent")} {money(c.spentVnd)} / {t("budget.limit")}{" "}
                  {money(c.weeklyLimitVnd)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label={t("budget.transactions.title")}>
        <h2>{t("budget.transactions.title")}</h2>
        {overview.transactions.length === 0 ? (
          <p>{t("budget.transactions.empty")}</p>
        ) : (
          <ul className="budget-list">
            {overview.transactions.map((tx) => (
              <li key={tx.id} className="budget-transaction">
                <p>
                  <strong>{tx.counterparty ?? tx.memo}</strong> {tx.direction === "in" ? "+" : "-"}
                  {money(tx.amountVnd)}
                </p>
                <p>
                  {when(tx.occurredAt)}
                  {tx.categoryId && names.get(tx.categoryId)
                    ? ` · ${names.get(tx.categoryId)}`
                    : ""}
                  {" · "}
                  {t(`budget.reconciliation.${tx.reconciliationResult}`)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label={t("budget.anomalies.title")}>
        <h2>{t("budget.anomalies.title")}</h2>
        {overview.anomalies.length === 0 ? (
          <p>{t("budget.anomalies.empty")}</p>
        ) : (
          <ul className="budget-list">
            {overview.anomalies.map((a) => (
              <li key={a.id} className="budget-anomaly">
                {t(`budget.anomaly.${a.kind}`)}
              </li>
            ))}
          </ul>
        )}
      </section>

      <button type="button" className="button" onClick={onRefresh}>
        {t("budget.refresh")}
      </button>
    </div>
  );
}
