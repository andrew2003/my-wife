"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  appearanceCookies,
  loadAppearance,
  saveAppearance,
  type Appearance,
} from "../lib/appearance";
import type { Locale } from "../lib/i18n";
import { DEFAULT_MODE, DEFAULT_SKIN } from "../lib/theme";
import { AppearanceView, type AppearanceSaveState, type AppearanceStatus } from "./appearance-view";

/** Saves skin and mode to the cookies (instant, every screen) and mirrors them to the profile. */
export function AppearanceScreen({ locale, current }: { locale: Locale; current: Appearance }) {
  const router = useRouter();
  const [status, setStatus] = useState<AppearanceStatus>("loading");
  const [appearance, setAppearance] = useState<Appearance>(current);
  const [saveState, setSaveState] = useState<AppearanceSaveState>("idle");

  const load = useCallback(async () => {
    const res = await loadAppearance();
    // The cookie wins on this device; the profile fills in only a fresh device.
    if (res.status === "ready" && current.skin === DEFAULT_SKIN && current.mode === DEFAULT_MODE) {
      setAppearance(res.appearance);
    }
    setStatus(res.status);
  }, [current.skin, current.mode]);

  useEffect(() => {
    void load();
  }, [load]);

  const onSave = async () => {
    setSaveState("saving");
    const secure = window.location.protocol === "https:";
    for (const cookie of appearanceCookies(appearance, secure)) document.cookie = cookie;
    // The root layout reads the cookies per request, so a refresh restyles every screen.
    router.refresh();
    setSaveState((await saveAppearance(appearance)) ? "saved" : "failed");
  };

  return (
    <AppearanceView
      locale={locale}
      status={status}
      appearance={appearance}
      saveState={saveState}
      onChange={(next) => {
        setSaveState("idle");
        setAppearance(next);
      }}
      onSave={() => void onSave()}
      onRefresh={() => {
        setStatus("loading");
        void load();
      }}
    />
  );
}
