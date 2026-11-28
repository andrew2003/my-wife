import type { FaultEntry } from "@my-wife/contracts";
import { canAppealFault, reasonKey } from "../lib/fault-ledger";
import { translate, type Locale } from "../lib/i18n";
import { ScreenState, stateKeys } from "./screen-state";

const FAULT_LEDGER_STATE_KEYS = stateKeys("fault");

export type FaultLedgerStatus = "loading" | "ready" | "empty" | "error";
export type FaultAppealState = "idle" | "sending" | "sent" | "failed";

export interface FaultLedgerViewProps {
  locale: Locale;
  status: FaultLedgerStatus;
  faults: FaultEntry[];
  timeZone: string;
  appealingId: string | null;
  appealState: FaultAppealState;
  onAppeal: (id: string) => void;
  onCancelAppeal: () => void;
  onSubmitAppeal: (id: string, reason: string) => void;
  onRefresh: () => void;
}

/** Presentational fault ledger with an appeal form; state lives in the client wrapper. */
export function FaultLedgerView(props: FaultLedgerViewProps) {
  const { locale, status, faults, timeZone, appealingId, appealState } = props;
  const t = (key: string, params?: Record<string, string | number>) =>
    translate(locale, key, params);
  const tag = locale === "vi" ? "vi-VN" : "en-US";
  const when = (iso: string) =>
    new Intl.DateTimeFormat(tag, { dateStyle: "medium", timeStyle: "short", timeZone }).format(
      new Date(iso),
    );

  if (status === "loading")
    return <ScreenState locale={locale} kind="loading" keys={FAULT_LEDGER_STATE_KEYS} />;
  if (status === "empty")
    return <ScreenState locale={locale} kind="empty" keys={FAULT_LEDGER_STATE_KEYS} />;
  if (status === "error") {
    return (
      <ScreenState
        locale={locale}
        kind="error"
        keys={FAULT_LEDGER_STATE_KEYS}
        onRetry={props.onRefresh}
      />
    );
  }

  return (
    <section aria-label={t("fault.title")}>
      <p>{t("fault.intro")}</p>
      <ul className="penalty-list">
        {faults.map((f) => (
          <li key={f.id} className="penalty-entry">
            <p>
              <strong>{t(`fault.type.${f.type}`)}</strong>{" "}
              <span>{t(`fault.status.${f.status}`)}</span>
            </p>
            <p>
              {f.points} {t("fault.points")}
            </p>
            <p>
              {t("fault.reason")} {t(reasonKey(f))}
            </p>
            <p>{when(f.occurredAt)}</p>
            {f.waiver ? (
              <p>
                {t("fault.waiver")} {t(`fault.waiver.${f.waiver}`)}
              </p>
            ) : null}
            {canAppealFault(f.status) && appealingId !== f.id ? (
              <button type="button" className="button" onClick={() => props.onAppeal(f.id)}>
                {t("fault.appeal.action")}
              </button>
            ) : null}
            {appealingId === f.id ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const data = new FormData(e.currentTarget);
                  props.onSubmitAppeal(f.id, String(data.get("reason") ?? ""));
                }}
              >
                <label>
                  {t("fault.appeal.reason")}
                  <textarea name="reason" required rows={3} />
                </label>
                {appealState === "failed" ? <p role="alert">{t("fault.appeal.failed")}</p> : null}
                <button type="submit" className="button" disabled={appealState === "sending"}>
                  {t("fault.appeal.submit")}
                </button>
                <button type="button" className="button" onClick={props.onCancelAppeal}>
                  {t("fault.appeal.cancel")}
                </button>
              </form>
            ) : null}
          </li>
        ))}
      </ul>
      {appealState === "sent" ? <p role="status">{t("fault.appeal.sent")}</p> : null}
      <button type="button" className="button" onClick={props.onRefresh}>
        {t("fault.refresh")}
      </button>
    </section>
  );
}
