"use client";

import { useCallback, useEffect, useState } from "react";
import type { Locale } from "../lib/i18n";
import {
  cellValue,
  loadBudgetSheet,
  saveBudgetCell,
  type BudgetSheet,
  type BudgetSheetTab,
} from "../lib/budget-sheet";
import { BudgetSheetView, type BudgetSheetStatus } from "./budget-sheet-view";

/** Loads the budget sheet by tab and writes edited plan cells through the budget service. */
export function BudgetSheetScreen({ locale }: { locale: Locale }) {
  const [tab, setTab] = useState<BudgetSheetTab>("categories");
  const [status, setStatus] = useState<BudgetSheetStatus>("loading");
  const [sheet, setSheet] = useState<BudgetSheet | null>(null);
  const [busyCell, setBusyCell] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await loadBudgetSheet(tab);
    if (res.status === "ready") setSheet(res.sheet);
    setStatus(res.status);
  }, [tab]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onSave = async (entityId: string, field: string, text: string) => {
    setBusyCell(`${entityId}:${field}`);
    setErrorKey(null);
    const res = await saveBudgetCell(tab, entityId, field, cellValue(field, text));
    if (!res.ok) setErrorKey(res.errorKey);
    // Reload either way so a rejected edit shows the stored value again.
    await refresh();
    setBusyCell(null);
  };

  return (
    <BudgetSheetView
      locale={locale}
      status={status}
      sheet={sheet}
      tab={tab}
      busyCell={busyCell}
      errorKey={errorKey}
      onTab={(next) => {
        setErrorKey(null);
        setStatus("loading");
        setTab(next);
      }}
      onSave={(id, field, text) => void onSave(id, field, text)}
      onRetry={() => {
        setStatus("loading");
        void refresh();
      }}
    />
  );
}
