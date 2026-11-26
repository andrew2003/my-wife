"use client";

import { useEffect, useState } from "react";
import type { Locale } from "../lib/i18n";
import { loadWakeToday, type WakeCardState } from "../lib/wake";
import { WakeCardView } from "./wake-card-view";

/** Loads today's recorded wake and shows the confirmation card when there is one. */
export function WakeCard({ locale }: { locale: Locale }) {
  const [state, setState] = useState<WakeCardState>({ status: "loading" });
  useEffect(() => {
    void loadWakeToday().then(setState);
  }, []);
  return <WakeCardView locale={locale} state={state} />;
}
