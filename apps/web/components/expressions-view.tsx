import { translate, type Locale } from "../lib/i18n";
import {
  EXPRESSION_KEYS,
  EXPRESSION_SETS,
  EXPRESSION_STATES,
  resolveExpression,
  switchSet,
  type ExpressionKey,
  type ExpressionSet,
  type ExpressionSettings,
  type ExpressionState,
} from "../lib/expressions";
import { Mascot } from "./mascot";

export type ExpressionsStatus = "loading" | "ready" | "error";
export type ExpressionsSaveState = "idle" | "saving" | "saved" | "failed";

export interface ExpressionsViewProps {
  locale: Locale;
  status: ExpressionsStatus;
  settings: ExpressionSettings;
  saveState: ExpressionsSaveState;
  /** False when no private art directory is configured; fallback art is drawn. */
  artAvailable: boolean;
  onChange: (next: ExpressionSettings) => void;
  onSave: () => void;
  onReset: () => void;
  onRefresh: () => void;
}

/** Presentational screen: pick the set, then the expression key for each state. */
export function ExpressionsView(props: ExpressionsViewProps) {
  const { locale, settings } = props;
  const t = (key: string) => translate(locale, key);
  if (props.status === "loading") return <p role="status">{t("expressions.loading")}</p>;
  if (props.status === "error") {
    return (
      <div>
        <p role="alert">{t("expressions.error")}</p>
        <button type="button" className="button" onClick={props.onRefresh}>
          {t("expressions.retry")}
        </button>
      </div>
    );
  }
  const busy = props.saveState === "saving";

  return (
    <section className="expressions" aria-label={t("expressions.title")}>
      <h2>{t("expressions.title")}</h2>
      <p>{t("expressions.help")}</p>
      <fieldset disabled={busy}>
        <legend>{t("expressions.set.label")}</legend>
        <select
          aria-label={t("expressions.set.label")}
          value={settings.set}
          onChange={(e) => props.onChange(switchSet(settings, e.target.value as ExpressionSet))}
        >
          {EXPRESSION_SETS.map((set) => (
            <option key={set} value={set}>
              {t(`expressions.set.${set}`)}
            </option>
          ))}
        </select>
        <p>{t("expressions.set.keeps_mapping")}</p>
      </fieldset>
      <fieldset disabled={busy}>
        <legend>{t("expressions.map.title")}</legend>
        <ul>
          {EXPRESSION_STATES.map((state: ExpressionState) => (
            <li key={state}>
              <Mascot
                artKey={resolveExpression(settings, state)}
                size="small"
                alt={t(`expressions.state.${state}`)}
                available={props.artAvailable}
              />
              <label>
                {t(`expressions.state.${state}`)}
                <select
                  value={settings.map[state]}
                  onChange={(e) =>
                    props.onChange({
                      ...settings,
                      map: { ...settings.map, [state]: e.target.value as ExpressionKey },
                    })
                  }
                >
                  {EXPRESSION_KEYS.map((key) => (
                    <option key={key} value={key}>
                      {t(`expressions.key.${key}`)}
                    </option>
                  ))}
                </select>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      <button type="button" className="button" disabled={busy} onClick={props.onSave}>
        {t("expressions.save")}
      </button>{" "}
      <button type="button" className="button" disabled={busy} onClick={props.onReset}>
        {t("expressions.reset")}
      </button>
      {busy ? <p role="status">{t("expressions.saving")}</p> : null}
      {props.saveState === "saved" ? <p role="status">{t("expressions.saved")}</p> : null}
      {props.saveState === "failed" ? <p role="alert">{t("expressions.save_failed")}</p> : null}
    </section>
  );
}
