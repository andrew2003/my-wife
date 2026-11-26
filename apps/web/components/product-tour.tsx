"use client";

import { useEffect, useState } from "react";
import type { Locale } from "../lib/i18n";
import { TOUR_STEPS, completeTour, loadTourState } from "../lib/tour";
import { TourView } from "./tour-view";

/** Shows the tour on the first sign-in only; skipping or finishing records the step. */
export function ProductTour({ locale }: { locale: Locale }) {
  const [visible, setVisible] = useState(false);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void loadTourState().then((state) => {
      if (live && state === "pending") setVisible(true);
    });
    return () => {
      live = false;
    };
  }, []);

  const finish = async (skipped: boolean) => {
    setBusy(true);
    setErrorKey(null);
    const saved = await completeTour(skipped);
    setBusy(false);
    if (saved) setVisible(false);
    else setErrorKey("tour.error");
  };

  if (!visible) return null;
  return (
    <TourView
      locale={locale}
      index={index}
      busy={busy}
      errorKey={errorKey}
      onNext={() =>
        index >= TOUR_STEPS.length - 1 ? void finish(false) : setIndex((i) => i + 1)
      }
      onSkip={() => void finish(true)}
    />
  );
}
