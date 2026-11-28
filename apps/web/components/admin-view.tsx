"use client";

import { FeatureFlagSchema } from "@my-wife/contracts";
import { useState } from "react";
import type { AdminAction, AdminData, IncidentDraft } from "../lib/admin";
import { translate, type Locale } from "../lib/i18n";
import { ScreenState, stateKeys } from "./screen-state";

const ADMIN_STATE_KEYS = stateKeys("admin");

export type AdminStatus = "loading" | "ready" | "forbidden" | "error";

export interface AdminViewProps {
  locale: Locale;
  status: AdminStatus;
  data: AdminData | null;
  timeZone: string;
  busy: boolean;
  actionError: boolean;
  onRefresh: () => void;
  onAction: (action: AdminAction) => void;
  onDeclare: (draft: IncidentDraft) => void;
}

/** Presentational admin page: five sections, no personal content. */
export function AdminView(props: AdminViewProps) {
  const { locale, status, data, timeZone, busy } = props;
  const t = (key: string, params?: Record<string, string | number>) =>
    translate(locale, key, params);
  const tag = locale === "vi" ? "vi-VN" : "en-US";
  const when = (iso: string) =>
    new Intl.DateTimeFormat(tag, { dateStyle: "medium", timeStyle: "short", timeZone }).format(
      new Date(iso),
    );

  const [email, setEmail] = useState("");
  const [reason, setReason] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [flagUser, setFlagUser] = useState("");
  const [flag, setFlag] =
    useState<(typeof FeatureFlagSchema.options)[number]>("camera_supervision");
  const [sender, setSender] = useState({ senderKey: "", senderAddress: "", dkimDomain: "" });

  if (status === "loading")
    return <ScreenState locale={locale} kind="loading" keys={ADMIN_STATE_KEYS} />;
  if (status === "forbidden") return <p role="alert">{t("admin.forbidden")}</p>;
  if (status === "error" || !data) {
    return (
      <ScreenState locale={locale} kind="error" keys={ADMIN_STATE_KEYS} onRetry={props.onRefresh} />
    );
  }

  const scopeText = (scope: "all" | string[]) =>
    scope === "all" ? t("admin.scope.all") : scope.join(", ");

  return (
    <div className="admin-page">
      {props.actionError ? <p role="alert">{t("admin.error.action")}</p> : null}

      <section aria-labelledby="admin-incidents">
        <h2 id="admin-incidents">{t("admin.incidents.title")}</h2>
        <form
          className="admin-form"
          onSubmit={(e) => {
            e.preventDefault();
            props.onDeclare({
              startsAt: startsAt ? new Date(startsAt).toISOString() : new Date().toISOString(),
              endsAt: null,
              scope: "all",
              reason,
            });
            setReason("");
          }}
        >
          <label>
            {t("admin.incidents.starts")}
            <input
              type="datetime-local"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
            />
          </label>
          <label>
            {t("admin.incidents.reason")}
            <input value={reason} required onChange={(e) => setReason(e.target.value)} />
          </label>
          <button type="submit" className="button" disabled={busy || !reason.trim()}>
            {t("admin.incidents.declare")}
          </button>
        </form>
        {data.incidents.length === 0 ? (
          <p>{t("admin.incidents.empty")}</p>
        ) : (
          <ul>
            {data.incidents.map((i) => (
              <li key={i.id} className="admin-item">
                <strong>{t(`admin.incident.state.${i.state}`)}</strong> {when(i.startsAt)}
                {i.endsAt ? ` - ${when(i.endsAt)}` : ""} ({scopeText(i.scope)})<div>{i.reason}</div>
                {i.state === "active" ? (
                  <button
                    type="button"
                    className="button"
                    disabled={busy}
                    onClick={() => props.onAction({ kind: "end_incident", id: i.id })}
                  >
                    {t("admin.incidents.end")}
                  </button>
                ) : null}
                {i.state === "active" || i.state === "ended" ? (
                  <button
                    type="button"
                    className="button"
                    disabled={busy}
                    onClick={() => props.onAction({ kind: "cancel_incident", id: i.id })}
                  >
                    {t("admin.incidents.cancel")}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="admin-invitations">
        <h2 id="admin-invitations">{t("admin.invitations.title")}</h2>
        <form
          className="admin-form"
          onSubmit={(e) => {
            e.preventDefault();
            props.onAction({ kind: "create_invitation", email });
            setEmail("");
          }}
        >
          <label>
            {t("admin.invitations.email")}
            <input type="email" value={email} required onChange={(e) => setEmail(e.target.value)} />
          </label>
          <button type="submit" className="button" disabled={busy || !email}>
            {t("admin.invitations.create")}
          </button>
        </form>
        {data.invitations.length === 0 ? (
          <p>{t("admin.invitations.empty")}</p>
        ) : (
          <ul>
            {data.invitations.map((inv) => {
              const state = inv.revokedAt ? "revoked" : inv.usedAt ? "used" : "open";
              return (
                <li key={inv.id} className="admin-item">
                  {inv.email} - {t(`admin.invitation.state.${state}`)} -{" "}
                  {t("admin.invitations.expires", { at: when(inv.expiresAt) })}
                  {state === "open" ? (
                    <button
                      type="button"
                      className="button"
                      disabled={busy}
                      onClick={() => props.onAction({ kind: "revoke_invitation", id: inv.id })}
                    >
                      {t("admin.invitations.revoke")}
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="admin-flags">
        <h2 id="admin-flags">{t("admin.flags.title")}</h2>
        <p>{t("admin.flags.intro")}</p>
        <form className="admin-form" onSubmit={(e) => e.preventDefault()}>
          <label>
            {t("admin.flags.user_id")}
            <input value={flagUser} onChange={(e) => setFlagUser(e.target.value)} />
          </label>
          <label>
            {t("admin.flags.flag")}
            <select value={flag} onChange={(e) => setFlag(FeatureFlagSchema.parse(e.target.value))}>
              {FeatureFlagSchema.options.map((f) => (
                <option key={f} value={f}>
                  {t(`admin.flag.${f}`)}
                </option>
              ))}
            </select>
          </label>
          {[true, false].map((enabled) => (
            <button
              key={String(enabled)}
              type="button"
              className="button"
              disabled={busy || !flagUser.trim()}
              onClick={() =>
                props.onAction({ kind: "set_flag", userId: flagUser.trim(), flag, enabled })
              }
            >
              {t(enabled ? "admin.flags.enable" : "admin.flags.disable")}
            </button>
          ))}
        </form>
      </section>

      <section aria-labelledby="admin-sender-map">
        <h2 id="admin-sender-map">{t("admin.sender_map.title")}</h2>
        <form
          className="admin-form"
          onSubmit={(e) => {
            e.preventDefault();
            props.onAction({ kind: "save_sender", entry: sender });
            setSender({ senderKey: "", senderAddress: "", dkimDomain: "" });
          }}
        >
          <label>
            {t("admin.sender_map.key")}
            <input
              value={sender.senderKey}
              required
              onChange={(e) => setSender({ ...sender, senderKey: e.target.value })}
            />
          </label>
          <label>
            {t("admin.sender_map.address")}
            <input
              value={sender.senderAddress}
              required
              onChange={(e) => setSender({ ...sender, senderAddress: e.target.value })}
            />
          </label>
          <label>
            {t("admin.sender_map.domain")}
            <input
              value={sender.dkimDomain}
              required
              onChange={(e) => setSender({ ...sender, dkimDomain: e.target.value })}
            />
          </label>
          <button type="submit" className="button" disabled={busy}>
            {t("admin.sender_map.save")}
          </button>
        </form>
        {data.senderMap.length === 0 ? (
          <p>{t("admin.sender_map.empty")}</p>
        ) : (
          <ul>
            {data.senderMap.map((s) => (
              <li key={s.senderKey} className="admin-item">
                {s.senderKey}: {s.senderAddress} {"->"} {s.dkimDomain}
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => props.onAction({ kind: "remove_sender", senderKey: s.senderKey })}
                >
                  {t("admin.sender_map.remove")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="admin-audit">
        <h2 id="admin-audit">{t("admin.audit.title")}</h2>
        <p>{t("admin.audit.intro")}</p>
        {data.audit.length === 0 ? (
          <p>{t("admin.audit.empty")}</p>
        ) : (
          <ul>
            {data.audit.map((a) => (
              <li key={a.id} className="admin-item">
                {when(a.at)} - {a.action}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
