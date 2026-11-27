import {
  LlmProviderSchema,
  ModelRoleSchema,
  type LlmKeyView,
  type ModelRole,
} from "@my-wife/contracts";
import { translate, type Locale } from "../lib/i18n";
import { maskKey, type HandoverResult, type SwitchInput } from "../lib/models";

export type ModelsStatus = "loading" | "ready" | "empty" | "error";
export type SwitchState =
  "idle" | "switching" | "refused_key_invalid" | "refused_not_ready" | "failed";

export interface ModelsViewProps {
  locale: Locale;
  status: ModelsStatus;
  keys: LlmKeyView[];
  switchState: SwitchState;
  handover: HandoverResult | null;
  onSwitch: (input: SwitchInput) => void;
  onRemove: (keyId: string) => void;
  onRefresh: () => void;
}

function HandoverReport({ locale, result }: { locale: Locale; result: HandoverResult }) {
  const t = (key: string, params?: Record<string, string | number>) =>
    translate(locale, key, params);
  const ratio = `${Math.round(result.passRatio * 100)}%`;
  const role = t(`models.role.${result.modelRole}`);
  return (
    <div role="status" className="handover">
      <p>
        {result.state === "passed"
          ? t("models.handover.passed", { role, ratio })
          : result.state === "failed"
            ? t("models.handover.failed", { role, ratio })
            : t("models.handover.pending", { role })}
      </p>
      {result.failedQuestions.length > 0 ? (
        <>
          <p>{t("models.handover.failed_questions")}</p>
          <ul>
            {result.failedQuestions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

/** Presentational model and key screen; state lives in the client wrapper. */
export function ModelsView(props: ModelsViewProps) {
  const t = (key: string) => translate(props.locale, key);
  if (props.status === "loading") return <p role="status">{t("models.loading")}</p>;
  if (props.status === "error") {
    return (
      <div>
        <p role="alert">{t("models.error")}</p>
        <button type="button" className="button" onClick={props.onRefresh}>
          {t("models.retry")}
        </button>
      </div>
    );
  }
  const busy = props.switchState === "switching";
  return (
    <section className="models" aria-label={t("models.title")}>
      <h2>{t("models.title")}</h2>
      {props.status === "empty" ? (
        <p>{t("models.empty")}</p>
      ) : (
        <ul>
          {props.keys.map((k) => (
            <li key={k.keyId}>
              <strong>{t(`models.role.${k.role}`)}</strong>: {k.model} ({k.provider})
              <p>
                {t("models.key_label")} <code>{maskKey()}</code>{" "}
                {k.valid ? t("models.key_valid") : t("models.key_invalid")}
              </p>
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => props.onRemove(k.keyId)}
              >
                {t("models.remove")}
              </button>
            </li>
          ))}
        </ul>
      )}
      <h3>{t("models.switch.title")}</h3>
      <p>{t("models.switch.help")}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const data = new FormData(form);
          const input = {
            provider: String(data.get("provider")),
            model: String(data.get("model")).trim(),
            role: String(data.get("role")),
            apiKey: String(data.get("apiKey")),
          } as SwitchInput;
          props.onSwitch(input);
          form.reset();
        }}
      >
        <label htmlFor="model-role">{t("models.field.role")}</label>
        <select id="model-role" name="role" defaultValue="primary" disabled={busy}>
          {ModelRoleSchema.options.map((r: ModelRole) => (
            <option key={r} value={r}>
              {t(`models.role.${r}`)}
            </option>
          ))}
        </select>
        <label htmlFor="model-provider">{t("models.field.provider")}</label>
        <select id="model-provider" name="provider" disabled={busy}>
          {LlmProviderSchema.options.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <label htmlFor="model-name">{t("models.field.model")}</label>
        <input id="model-name" name="model" type="text" required disabled={busy} />
        <label htmlFor="model-api-key">{t("models.field.api_key")}</label>
        <input
          id="model-api-key"
          name="apiKey"
          type="password"
          autoComplete="off"
          required
          disabled={busy}
        />
        <button type="submit" className="button" disabled={busy}>
          {t("models.switch.submit")}
        </button>
      </form>
      {busy ? <p role="status">{t("models.switch.running")}</p> : null}
      {props.switchState === "refused_key_invalid" ? (
        <p role="alert">{t("models.switch.key_invalid")}</p>
      ) : null}
      {props.switchState === "refused_not_ready" ? (
        <p role="alert">{t("models.switch.not_ready")}</p>
      ) : null}
      {props.switchState === "failed" ? <p role="alert">{t("models.switch.failed")}</p> : null}
      {props.handover ? <HandoverReport locale={props.locale} result={props.handover} /> : null}
    </section>
  );
}
