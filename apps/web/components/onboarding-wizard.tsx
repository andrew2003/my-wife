"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { signContract } from "../lib/contract";
import { ContractSigningView } from "./contract-signing-view";
import type { Locale } from "../lib/i18n";
import {
  buildAnswers,
  finishQuestions,
  loadPreviews,
  type AnswerSetting,
  type FormValues,
  type Previews,
} from "../lib/onboarding";
import { OnboardingWizardView, type WizardPhase } from "./onboarding-wizard-view";

/** Client state of the onboarding wizard: questions, then the generated templates to review. */
export function OnboardingWizard({ locale }: { locale: Locale }) {
  const router = useRouter();
  const [phase, setPhase] = useState<WizardPhase | "contract">("questions");
  const [agreed, setAgreed] = useState(false);
  const [signing, setSigning] = useState(false);
  const [values, setValues] = useState<FormValues>({});
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Previews | null>(null);
  // Set once the step was saved, so a retry only re-reads the previews.
  const [saved, setSaved] = useState(false);

  const run = async (skipped: boolean) => {
    setErrorKey(null);
    const built = skipped ? { ok: true as const, answers: {} } : buildAnswers(values);
    if (!built.ok) {
      setErrorKey(built.errorKey);
      return;
    }
    setPhase("loading");
    const result = await finishQuestions(built.answers, skipped);
    if (result.ok) {
      setSaved(true);
      setPreviews(result.previews);
      setPhase("review");
    } else {
      setErrorKey(result.errorKey);
      setSaved(result.errorKey === "onboarding.error.previews");
      setPhase("questions");
    }
  };

  const retry = async () => {
    setErrorKey(null);
    setPhase("loading");
    const found = await loadPreviews();
    if (found) {
      setPreviews(found);
      setPhase("review");
    } else {
      setErrorKey("onboarding.error.previews");
      setPhase("questions");
    }
  };

  const sign = async () => {
    setErrorKey(null);
    setSigning(true);
    const result = await signContract(previews?.budget.cycle.id);
    if (result.ok) {
      // Onboarding is complete: open the home screen.
      router.push("/");
      return;
    }
    setSigning(false);
    setErrorKey(result.errorKey);
  };

  if (phase === "contract" && previews) {
    return (
      <main className="onboarding">
        <ContractSigningView
          locale={locale}
          budget={previews.budget}
          agreed={agreed}
          busy={signing}
          errorKey={errorKey}
          onAgreeChange={setAgreed}
          onSign={() => void sign()}
        />
      </main>
    );
  }

  return (
    <OnboardingWizardView
      locale={locale}
      phase={phase as WizardPhase}
      values={values}
      busy={phase === "loading"}
      errorKey={errorKey}
      previews={previews}
      onChange={(setting: AnswerSetting, value: string) =>
        setValues((v) => ({ ...v, [setting]: value }))
      }
      onContinue={() => void (saved ? retry() : run(false))}
      onSkip={() => void (saved ? retry() : run(true))}
      onRetry={() => void retry()}
      onToContract={() => {
        setErrorKey(null);
        setPhase("contract");
      }}
    />
  );
}
