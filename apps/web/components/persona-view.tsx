import { translate, type Locale } from "../lib/i18n";
import {
  PERSONA_KEYS,
  resolveTerms,
  tp,
  type PersonaField,
  type PersonaSettings,
  type PersonaTerm,
} from "../lib/persona";

export type PersonaStatus = "loading" | "ready" | "error";
export type PersonaSaveState = "idle" | "saving" | "saved" | "failed";

export interface PersonaViewProps {
  locale: Locale;
  status: PersonaStatus;
  settings: PersonaSettings;
  saveState: PersonaSaveState;
  onChange: (next: PersonaSettings) => void;
  onSave: () => void;
  onReset: () => void;
  onRefresh: () => void;
}

/** Presentational address-terms screen: three lists for the active locale, edited in place. */
export function PersonaView(props: PersonaViewProps) {
  const { locale, settings } = props;
  const t = (key: string) => translate(locale, key);
  if (props.status === "loading") return <p role="status">{t("persona.loading")}</p>;
  if (props.status === "error") {
    return (
      <div>
        <p role="alert">{t("persona.error")}</p>
        <button type="button" className="button" onClick={props.onRefresh}>
          {t("persona.retry")}
        </button>
      </div>
    );
  }

  const update = (field: PersonaField, terms: PersonaTerm[]) =>
    props.onChange({ ...settings, [field]: { ...settings[field], [locale]: terms } });
  const busy = props.saveState === "saving";
  const terms = resolveTerms(settings, locale);

  return (
    <section className="persona" aria-label={t("persona.title")}>
      <h2>{t("persona.title")}</h2>
      <p>{t("persona.help")}</p>
      {PERSONA_KEYS.map(({ field }) => {
        const list = settings[field][locale];
        return (
          <fieldset key={field} disabled={busy}>
            <legend>{t(`persona.list.${field}`)}</legend>
            <p>{t(`persona.list.${field}.help`)}</p>
            {list.length === 0 ? (
              <p>{t("persona.list.empty")}</p>
            ) : (
              <ul>
                {list.map((term, i) => (
                  <li key={`${field}-${i}`}>
                    <input
                      type="text"
                      value={term.text}
                      aria-label={t("persona.term.label")}
                      onChange={(e) =>
                        update(
                          field,
                          list.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)),
                        )
                      }
                    />
                    <label>
                      <input
                        type="checkbox"
                        checked={term.enabled}
                        onChange={(e) =>
                          update(
                            field,
                            list.map((x, j) => (j === i ? { ...x, enabled: e.target.checked } : x)),
                          )
                        }
                      />{" "}
                      {t("persona.term.enabled")}
                    </label>
                    <button
                      type="button"
                      className="button"
                      onClick={() =>
                        update(
                          field,
                          list.filter((_, j) => j !== i),
                        )
                      }
                    >
                      {t("persona.term.remove")}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const form = e.currentTarget;
                const text = String(new FormData(form).get("text") ?? "").trim();
                if (text === "") return;
                update(field, [...list, { text, enabled: true }]);
                form.reset();
              }}
            >
              <input
                name="text"
                type="text"
                placeholder={t("persona.add.placeholder")}
                aria-label={t("persona.add.label")}
              />
              <button type="submit" className="button">
                {t("persona.add.submit")}
              </button>
            </form>
          </fieldset>
        );
      })}
      <h3>{t("persona.preview.title")}</h3>
      <p>{tp(locale, "persona.sample.greeting", terms)}</p>
      <p>{tp(locale, "persona.sample.label", terms)}</p>
      <button type="button" className="button" disabled={busy} onClick={props.onSave}>
        {t("persona.save")}
      </button>{" "}
      <button type="button" className="button" disabled={busy} onClick={props.onReset}>
        {t("persona.reset")}
      </button>
      {busy ? <p role="status">{t("persona.saving")}</p> : null}
      {props.saveState === "saved" ? <p role="status">{t("persona.saved")}</p> : null}
      {props.saveState === "failed" ? <p role="alert">{t("persona.save_failed")}</p> : null}
    </section>
  );
}
