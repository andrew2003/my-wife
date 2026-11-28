"use client";

import { useCallback, useEffect, useState } from "react";
import type { Locale } from "../lib/i18n";
import { cellValue, loadSheet, saveCell, type Sheet } from "../lib/timetable-sheet";
import { TimetableSheetView, type TimetableSheetStatus } from "./timetable-sheet-view";

/** Loads the timetable sheet and writes edited cells through the schedule service. */
export function TimetableSheetScreen({ locale, weekId }: { locale: Locale; weekId?: string }) {
  const [status, setStatus] = useState<TimetableSheetStatus>("loading");
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [busyCell, setBusyCell] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await loadSheet(weekId);
    if (res.status === "ready") setSheet(res.sheet);
    setStatus(res.status);
  }, [weekId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onSave = async (entityId: string, field: string, text: string) => {
    setBusyCell(`${entityId}:${field}`);
    setErrorKey(null);
    const res = await saveCell(entityId, field, cellValue(field, text));
    if (!res.ok) setErrorKey(res.errorKey);
    // Reload either way so a rejected edit shows the stored value again.
    await refresh();
    setBusyCell(null);
  };

  return (
    <TimetableSheetView
      locale={locale}
      status={status}
      sheet={sheet}
      busyCell={busyCell}
      errorKey={errorKey}
      onSave={(id, field, text) => void onSave(id, field, text)}
      onRetry={() => {
        setStatus("loading");
        void refresh();
      }}
    />
  );
}
