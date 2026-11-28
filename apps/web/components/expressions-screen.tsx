"use client";

import { useCallback, useEffect, useState } from "react";
import type { Locale } from "../lib/i18n";
import {
  defaultExpressionSettings,
  loadExpressions,
  saveExpressions,
  type ExpressionSettings,
} from "../lib/expressions";
import {
  ExpressionsView,
  type ExpressionsSaveState,
  type ExpressionsStatus,
} from "./expressions-view";

/** Loads the expression set and mapping and saves them back to the user's settings. */
export function ExpressionsScreen({
  locale,
  artAvailable,
}: {
  locale: Locale;
  artAvailable: boolean;
}) {
  const [status, setStatus] = useState<ExpressionsStatus>("loading");
  const [settings, setSettings] = useState<ExpressionSettings>(defaultExpressionSettings);
  const [saveState, setSaveState] = useState<ExpressionsSaveState>("idle");

  const load = useCallback(async () => {
    const res = await loadExpressions();
    if (res.status === "ready") setSettings(res.settings);
    setStatus(res.status);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onSave = async () => {
    setSaveState("saving");
    setSaveState((await saveExpressions(settings)) ? "saved" : "failed");
  };

  return (
    <ExpressionsView
      locale={locale}
      status={status}
      settings={settings}
      saveState={saveState}
      artAvailable={artAvailable}
      onChange={(next) => {
        setSaveState("idle");
        setSettings(next);
      }}
      onSave={() => void onSave()}
      onReset={() => {
        setSaveState("idle");
        setSettings(defaultExpressionSettings());
      }}
      onRefresh={() => {
        setStatus("loading");
        void load();
      }}
    />
  );
}
