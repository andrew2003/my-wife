import type { Appearance } from "../lib/appearance";
import { translate, type Locale } from "../lib/i18n";
import { MODES, SKINS } from "../lib/theme";
import { ScreenState, stateKeys } from "./screen-state";

const APPEARANCE_STATE_KEYS = stateKeys("appearance");

export type AppearanceStatus = "loading" | "ready" | "error";
export type AppearanceSaveState = "idle" | "saving" | "saved" | "failed";

export interface AppearanceViewProps {
  locale: Locale;
  status: AppearanceStatus;
  appearance: Appearance;
  saveState: AppearanceSaveState;
  onChange: (next: Appearance) => void;
  onSave: () => void;
  onRefresh: () => void;
}

/** Presentational appearance screen: skin and mode as two segmented groups. */
export function AppearanceView(props: AppearanceViewProps) {
  const { locale, appearance } = props;
  const t = (key: string) => translate(locale, key);
  if (props.status === "loading")
    return <ScreenState locale={props.locale} kind="loading" keys={APPEARANCE_STATE_KEYS} />;
  if (props.status === "error") {
    return (
      <ScreenState
        locale={props.locale}
        kind="error"
        keys={APPEARANCE_STATE_KEYS}
        onRetry={props.onRefresh}
      />
    );
  }
  const busy = props.saveState === "saving";
  return (
    <section className="appearance" aria-label={t("appearance.title")}>
      <h2>{t("appearance.title")}</h2>
      <p>{t("appearance.help")}</p>
      <fieldset disabled={busy}>
        <legend>{t("appearance.skin.label")}</legend>
        {SKINS.map((skin) => (
          <button
            key={skin}
            type="button"
            className="button"
            aria-pressed={appearance.skin === skin}
            onClick={() => props.onChange({ ...appearance, skin })}
          >
            {t(`appearance.skin.${skin}`)}
          </button>
        ))}
      </fieldset>
      <fieldset disabled={busy}>
        <legend>{t("appearance.mode.label")}</legend>
        {MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            className="button"
            aria-pressed={appearance.mode === mode}
            onClick={() => props.onChange({ ...appearance, mode })}
          >
            {t(`appearance.mode.${mode}`)}
          </button>
        ))}
      </fieldset>
      <button type="button" className="button" disabled={busy} onClick={props.onSave}>
        {t("appearance.save")}
      </button>
      {props.saveState === "saved" ? <p role="status">{t("appearance.saved")}</p> : null}
      {props.saveState === "failed" ? <p role="alert">{t("appearance.failed")}</p> : null}
    </section>
  );
}
