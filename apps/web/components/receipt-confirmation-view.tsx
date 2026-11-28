import type { ReceiptParsedPayload, ReceiptState } from "@my-wife/contracts";
import { translate, type Locale } from "../lib/i18n";
import { isAwaitingConfirmation } from "../lib/receipt-confirmation";
import { ScreenState, stateKeys } from "./screen-state";

const RECEIPT_CONFIRMATION_STATE_KEYS = stateKeys("receipt", { empty: "receipt.not_found" });

export type ReceiptStatus = "loading" | "ready" | "empty" | "error";
export type ReceiptOutcome = "confirmed" | "rejected" | "failed" | null;

export interface ReceiptConfirmationViewProps {
  locale: Locale;
  status: ReceiptStatus;
  state: ReceiptState | null;
  receipt: ReceiptParsedPayload | null;
  timeZone: string;
  busy: boolean;
  outcome: ReceiptOutcome;
  onConfirm: () => void;
  onReject: () => void;
  onRetry: () => void;
}

/** Parsed fields of a receipt with confirm and reject while it waits for the user. */
export function ReceiptConfirmationView(props: ReceiptConfirmationViewProps) {
  const { locale, status, state, receipt, timeZone, busy, outcome } = props;
  const t = (key: string) => translate(locale, key);
  const tag = locale === "vi" ? "vi-VN" : "en-US";

  if (status === "loading")
    return <ScreenState locale={locale} kind="loading" keys={RECEIPT_CONFIRMATION_STATE_KEYS} />;
  if (status === "empty")
    return <ScreenState locale={locale} kind="empty" keys={RECEIPT_CONFIRMATION_STATE_KEYS} />;
  if (status === "error" || !receipt || !state) {
    return (
      <ScreenState
        locale={locale}
        kind="error"
        keys={RECEIPT_CONFIRMATION_STATE_KEYS}
        onRetry={props.onRetry}
      />
    );
  }

  const amount = `${new Intl.NumberFormat(tag).format(receipt.amountVnd)} ${t("receipt.currency")}`;
  const when = new Intl.DateTimeFormat(tag, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(new Date(receipt.occurredAt));
  const rows: [string, string][] = [
    [t("receipt.field.direction"), t(`receipt.direction.${receipt.direction}`)],
    [t("receipt.field.amount"), amount],
    [t("receipt.field.counterparty"), receipt.counterparty ?? t("receipt.none")],
    [t("receipt.field.memo"), receipt.memo || t("receipt.none")],
    [t("receipt.field.occurred_at"), when],
    [t("receipt.field.reference"), receipt.bankTransactionRef],
    [t("receipt.field.account"), receipt.bankAccountHint],
    [t("receipt.field.source"), t(`receipt.source.${receipt.source}`)],
  ];

  return (
    <div>
      <p>{t("receipt.intro")}</p>
      <p>
        {t("receipt.state")} <strong>{t(`receipt.state.${state}`)}</strong>
      </p>
      <dl className="penalty-entry">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {outcome === "confirmed" && <p role="status">{t("receipt.confirmed")}</p>}
      {outcome === "rejected" && <p role="status">{t("receipt.rejected")}</p>}
      {outcome === "failed" && <p role="alert">{t("receipt.action_failed")}</p>}
      {isAwaitingConfirmation(state) ? (
        <div>
          <button type="button" className="button" disabled={busy} onClick={props.onConfirm}>
            {t("receipt.confirm")}
          </button>{" "}
          <button type="button" className="button" disabled={busy} onClick={props.onReject}>
            {t("receipt.reject")}
          </button>
        </div>
      ) : (
        <p>{t("receipt.not_waiting")}</p>
      )}
    </div>
  );
}
