import { ConsentKindSchema, type ConsentKind } from "@my-wife/contracts";
import { translate, type Locale } from "../lib/i18n";
import type { ConsentRecord, ExportResult } from "../lib/privacy";

export type PrivacyStatus = "loading" | "ready" | "error";
export type ExportState = { status: "idle" | "working" | "failed" } | ExportResult;
export type DeletionState = "idle" | "working" | "not_confirmed" | "failed" | "closing" | "closed";

export interface PrivacyViewProps {
  locale: Locale;
  status: PrivacyStatus;
  consents: ConsentRecord[];
  exportState: ExportState;
  deletionState: DeletionState;
  confirmOpen: boolean;
  onGrant: (kind: string) => void;
  onRevoke: (kind: string) => void;
  onExport: () => void;
  onOpenConfirm: () => void;
  onCancelConfirm: () => void;
  onDelete: (confirmation: string) => void;
  onRefresh: () => void;
}

/** Presentational consents, export and deletion screen; state lives in the client wrapper. */
export function PrivacyView(props: PrivacyViewProps) {
  const t = (key: string, params?: Record<string, string | number>) =>
    translate(props.locale, key, params);
  if (props.status === "loading") return <p role="status">{t("privacy.loading")}</p>;
  if (props.status === "error") {
    return (
      <div>
        <p role="alert">{t("privacy.error")}</p>
        <button type="button" className="button" onClick={props.onRefresh}>
          {t("privacy.retry")}
        </button>
      </div>
    );
  }
  const active = new Set(props.consents.filter((c) => !c.revokedAt).map((c) => c.kind));
  const exp = props.exportState;
  const deleting = props.deletionState === "working";
  const finished = props.deletionState === "closing" || props.deletionState === "closed";
  return (
    <section className="privacy" aria-label={t("privacy.title")}>
      <h2>{t("privacy.consent.title")}</h2>
      <p>{t("privacy.consent.help")}</p>
      <ul>
        {ConsentKindSchema.options.map((kind: ConsentKind) => (
          <li key={kind}>
            <strong>{t(`privacy.consent.${kind}`)}</strong>
            <p>{t(`privacy.consent.${kind}.help`)}</p>
            <p>{active.has(kind) ? t("privacy.consent.on") : t("privacy.consent.off")}</p>
            {active.has(kind) ? (
              <button type="button" className="button" onClick={() => props.onRevoke(kind)}>
                {t("privacy.consent.revoke")}
              </button>
            ) : (
              <button type="button" className="button" onClick={() => props.onGrant(kind)}>
                {t("privacy.consent.grant")}
              </button>
            )}
          </li>
        ))}
      </ul>

      <h2>{t("privacy.export.title")}</h2>
      <p>{t("privacy.export.help")}</p>
      <button
        type="button"
        className="button"
        disabled={exp.status === "working"}
        onClick={props.onExport}
      >
        {t("privacy.export.button")}
      </button>
      {exp.status === "working" ? <p role="status">{t("privacy.export.working")}</p> : null}
      {exp.status === "failed" || exp.status === "error" ? (
        <p role="alert">{t("privacy.export.failed")}</p>
      ) : null}
      {exp.status === "ready" ? (
        <p role="status">
          <a href={exp.downloadUrl} download>
            {t("privacy.export.download")}
          </a>{" "}
          {t("privacy.export.expires", { at: exp.expiresAt })}
        </p>
      ) : null}

      <h2>{t("privacy.delete.title")}</h2>
      {finished ? (
        <p role="status">
          {props.deletionState === "closing"
            ? t("privacy.delete.closing")
            : t("privacy.delete.closed")}
        </p>
      ) : !props.confirmOpen ? (
        <>
          <p>{t("privacy.delete.help")}</p>
          <button type="button" className="button" onClick={props.onOpenConfirm}>
            {t("privacy.delete.open")}
          </button>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            props.onDelete(String(new FormData(e.currentTarget).get("confirmation") ?? ""));
          }}
        >
          <p role="alert">{t("privacy.delete.warning")}</p>
          <label htmlFor="delete-confirmation">{t("privacy.delete.label")}</label>
          <input
            id="delete-confirmation"
            name="confirmation"
            type="email"
            autoComplete="off"
            required
            disabled={deleting}
          />
          <button type="submit" className="button" disabled={deleting}>
            {t("privacy.delete.confirm")}
          </button>
          <button
            type="button"
            className="button"
            disabled={deleting}
            onClick={props.onCancelConfirm}
          >
            {t("privacy.delete.cancel")}
          </button>
          {props.deletionState === "not_confirmed" ? (
            <p role="alert">{t("privacy.delete.not_confirmed")}</p>
          ) : null}
          {props.deletionState === "failed" ? (
            <p role="alert">{t("privacy.delete.failed")}</p>
          ) : null}
        </form>
      )}
    </section>
  );
}
