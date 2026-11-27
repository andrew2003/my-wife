import { translate } from "../lib/i18n";
import { SLEEP_NUMBER_KEYS, SLEEP_TIME_KEYS, type SleepKey } from "../lib/routines";
import { SaveFeedback, routinesStatusView, type RoutinesViewProps } from "./routines-view";

/** Presentational sleep and wake-up screen: every time and threshold is an editable setting. */
export function SleepView(props: RoutinesViewProps) {
  const t = (key: string) => translate(props.locale, key);
  const early = routinesStatusView(props);
  if (early || !props.data) return early;
  const { data } = props;
  const busy = props.saveState === "saving";

  const field = (key: SleepKey, type: "time" | "number") => {
    const id = `sleep-${key}`;
    return (
      <li key={key}>
        <label htmlFor={id}>{t(`sleep.field.${key}`)}</label>{" "}
        <input
          id={id}
          type={type}
          min={type === "number" ? 0 : undefined}
          defaultValue={data.sleep[key]}
          disabled={busy}
          onBlur={(e) => {
            const raw = e.target.value;
            if (raw === "" || raw === String(data.sleep[key])) return;
            props.onChange(key, type === "number" ? Number(raw) : raw);
          }}
        />
        {key === "routine.wake_second_check_minutes" ? <p>{t("sleep.second_check_off")}</p> : null}
      </li>
    );
  };

  return (
    <section className="sleep" aria-label={t("sleep.title")}>
      <h2>{t("sleep.title")}</h2>
      <p>{t("sleep.intro")}</p>
      <SaveFeedback {...props} />
      <ul>
        {SLEEP_TIME_KEYS.map((k) => field(k, "time"))}
        {SLEEP_NUMBER_KEYS.map((k) => field(k, "number"))}
      </ul>
    </section>
  );
}
