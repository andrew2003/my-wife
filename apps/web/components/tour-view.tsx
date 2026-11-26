import { translate, type Locale } from "../lib/i18n";
import { TOUR_STEPS } from "../lib/tour";

export interface TourViewProps {
  locale: Locale;
  index: number;
  /** A save is in flight. */
  busy: boolean;
  /** Locale key of the last save error, if any. */
  errorKey: string | null;
  onNext: () => void;
  onSkip: () => void;
}

/** One tour step with Skip on every step; state lives in the client wrapper. */
export function TourView({ locale, index, busy, errorKey, onNext, onSkip }: TourViewProps) {
  const t = (key: string, params?: Record<string, string | number>) =>
    translate(locale, key, params);
  const step = TOUR_STEPS[Math.min(index, TOUR_STEPS.length - 1)]!;
  const last = index >= TOUR_STEPS.length - 1;
  return (
    <div className="tour-backdrop">
      <section role="dialog" aria-modal="true" aria-label={t("tour.label")} className="tour">
        <p className="tour-progress">
          {t("tour.progress", { current: index + 1, total: TOUR_STEPS.length })}
        </p>
        <h2>{t(step.titleKey)}</h2>
        <p>{t(step.bodyKey)}</p>
        {errorKey ? <p role="alert">{t(errorKey)}</p> : null}
        <div className="tour-actions">
          <button type="button" className="button" disabled={busy} onClick={onSkip}>
            {t("tour.skip")}
          </button>
          <button type="button" className="button" disabled={busy} onClick={onNext}>
            {last ? t("tour.finish") : t("tour.next")}
          </button>
        </div>
      </section>
    </div>
  );
}
