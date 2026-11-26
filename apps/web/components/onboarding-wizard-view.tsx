import { translate, type Locale } from "../lib/i18n";
import { QUESTIONS, type AnswerSetting, type FormValues, type Previews } from "../lib/onboarding";

export type WizardPhase = "questions" | "loading" | "review";

export interface OnboardingWizardViewProps {
  locale: Locale;
  phase: WizardPhase;
  values: FormValues;
  busy: boolean;
  /** Locale key of the last error, if any. */
  errorKey: string | null;
  previews: Previews | null;
  onChange: (setting: AnswerSetting, value: string) => void;
  onContinue: () => void;
  onSkip: () => void;
  /** Retry reading the previews after an error. */
  onRetry: () => void;
}

/** Questions step (every question skippable), then a review of the generated templates. */
export function OnboardingWizardView(props: OnboardingWizardViewProps) {
  const { locale, phase, values, busy, errorKey, previews } = props;
  const t = (key: string, params?: Record<string, string | number>) =>
    translate(locale, key, params);
  const money = new Intl.NumberFormat(locale === "vi" ? "vi-VN" : "en-US");

  return (
    <main className="onboarding">
      <h1>{t("onboarding.title")}</h1>
      {errorKey ? (
        <p role="alert">
          {t(errorKey)}
          {phase === "questions" &&
          previews === null &&
          errorKey === "onboarding.error.previews" ? (
            <button type="button" className="button" onClick={props.onRetry}>
              {t("onboarding.retry")}
            </button>
          ) : null}
        </p>
      ) : null}

      {phase === "questions" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            props.onContinue();
          }}
        >
          <p>{t("onboarding.questions.intro")}</p>
          {QUESTIONS.map((q) => (
            <label key={q.setting} className="onboarding-field">
              <span>{t(q.labelKey)}</span>
              <input
                type={q.input}
                name={q.setting}
                min={q.input === "number" ? 1 : undefined}
                value={values[q.setting] ?? ""}
                disabled={busy}
                onChange={(e) => props.onChange(q.setting, e.target.value)}
              />
            </label>
          ))}
          <div className="onboarding-actions">
            <button type="button" className="button" disabled={busy} onClick={props.onSkip}>
              {t("onboarding.skip")}
            </button>
            <button type="submit" className="button" disabled={busy}>
              {t("onboarding.continue")}
            </button>
          </div>
        </form>
      ) : null}

      {phase === "loading" ? <p role="status">{t("onboarding.loading")}</p> : null}

      {phase === "review" && previews ? (
        <div>
          <p>{t("onboarding.review.intro")}</p>
          <section aria-label={t("onboarding.review.schedule")}>
            <h2>{t("onboarding.review.schedule")}</h2>
            {previews.schedule.length === 0 ? (
              <p>{t("onboarding.review.schedule_empty")}</p>
            ) : (
              <ul>
                {previews.schedule.map((b) => (
                  <li key={`${b.titleKey}-${b.start}`}>
                    <span>{b.start === b.end ? b.start : `${b.start} - ${b.end}`}</span>{" "}
                    <strong>{t(b.titleKey)}</strong>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-label={t("onboarding.review.budget")}>
            <h2>{t("onboarding.review.budget")}</h2>
            <p>
              {t("onboarding.review.cycle", {
                weeks: previews.budget.cycle.weeks,
                firstDay: previews.budget.cycle.firstDay,
              })}
            </p>
            {previews.budget.categories.length === 0 ? (
              <p>{t("onboarding.review.budget_empty")}</p>
            ) : (
              <ul>
                {previews.budget.categories.map((c) => (
                  <li key={c.id}>
                    <strong>{c.name}</strong>{" "}
                    <span>
                      {money.format(c.cycleLimitVnd)} {t("onboarding.review.currency")}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <p>{t("onboarding.review.editable")}</p>
        </div>
      ) : null}
    </main>
  );
}
