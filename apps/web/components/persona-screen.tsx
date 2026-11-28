"use client";

import { useCallback, useEffect, useState } from "react";
import type { Locale } from "../lib/i18n";
import {
  defaultPersonaSettings,
  loadPersona,
  savePersona,
  type PersonaSettings,
} from "../lib/persona";
import { PersonaView, type PersonaSaveState, type PersonaStatus } from "./persona-view";

/** Loads the address-term lists and saves them back to the user's settings. */
export function PersonaScreen({ locale }: { locale: Locale }) {
  const [status, setStatus] = useState<PersonaStatus>("loading");
  const [settings, setSettings] = useState<PersonaSettings>(defaultPersonaSettings);
  const [saveState, setSaveState] = useState<PersonaSaveState>("idle");

  const load = useCallback(async () => {
    const res = await loadPersona();
    if (res.status === "ready") setSettings(res.settings);
    setStatus(res.status);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onSave = async () => {
    setSaveState("saving");
    setSaveState((await savePersona(settings)) ? "saved" : "failed");
  };

  return (
    <PersonaView
      locale={locale}
      status={status}
      settings={settings}
      saveState={saveState}
      onChange={(next) => {
        setSaveState("idle");
        setSettings(next);
      }}
      onSave={() => void onSave()}
      onReset={() => {
        setSaveState("idle");
        setSettings((cur) => {
          const d = defaultPersonaSettings();
          // Reset only the active locale's lists; the other locale keeps the user's edits.
          return {
            address_user: { ...cur.address_user, [locale]: d.address_user[locale] },
            self_reference: { ...cur.self_reference, [locale]: d.self_reference[locale] },
            wife_label: { ...cur.wife_label, [locale]: d.wife_label[locale] },
          };
        });
      }}
      onRefresh={() => {
        setStatus("loading");
        void load();
      }}
    />
  );
}
