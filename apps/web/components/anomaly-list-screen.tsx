"use client";

import type { AnomalyView } from "@my-wife/contracts";
import { useCallback, useEffect, useState } from "react";
import { loadOverview } from "../lib/budget-overview";
import type { Locale } from "../lib/i18n";
import { AnomalyListView, type AnomalyListStatus } from "./anomaly-list-view";

/** Loads the open anomalies of the current cycle. */
export function AnomalyListScreen({ locale }: { locale: Locale }) {
  const [status, setStatus] = useState<AnomalyListStatus>("loading");
  const [anomalies, setAnomalies] = useState<AnomalyView[]>([]);

  const load = useCallback(async () => {
    setStatus("loading");
    const res = await loadOverview();
    if (res.status !== "ready") {
      setStatus(res.status);
      return;
    }
    setAnomalies(res.overview.anomalies);
    setStatus(res.overview.anomalies.length === 0 ? "empty" : "ready");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <AnomalyListView
      locale={locale}
      status={status}
      anomalies={anomalies}
      onRetry={() => void load()}
    />
  );
}
