import { translate, type Locale } from "../lib/i18n";
import { formatWakeTime, type WakeCardState } from "../lib/wake";

/** Confirmation of the recorded wake; renders nothing unless a wake is recorded. */
export function WakeCardView(props: { locale: Locale; state: WakeCardState; timeZone?: string }) {
  const { locale, state, timeZone } = props;
  if (state.status !== "recorded") return null;
  const t = (key: string, params?: Record<string, string | number>) =>
    translate(locale, key, params);
  return (
    <section className="checklist-note wake-card" aria-label={t("wake.title")}>
      <h2>{t("wake.title")}</h2>
      <p>{t("wake.recorded", { time: formatWakeTime(state.wakeTime, timeZone) })}</p>
      <p>
        {state.minutesLate === 0
          ? t("wake.on_time")
          : t("wake.late", { minutes: state.minutesLate })}
      </p>
    </section>
  );
}
