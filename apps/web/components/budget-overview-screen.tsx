"use client";

import { useCallback, useEffect, useState } from "react";
import {
  loadOverview,
  loadPenalties,
  type Overview,
  type PenaltiesResult,
} from "../lib/budget-overview";
import type { Locale } from "../lib/i18n";
import { BudgetOverviewView, type OverviewStatus } from "./budget-overview-view";

/** Loads the overview and the due penalties; a penalty failure never hides the overview. */
export function BudgetOverviewScreen({ locale }: { locale: Locale }) {
  const [status, setStatus] = useState<OverviewStatus>("loading");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [penalties, setPenalties] = useState<PenaltiesResult>({ status: "loading" });

  const load = useCallback(async () => {
    setStatus("loading");
    const [o, p] = await Promise.all([loadOverview(), loadPenalties()]);
    if (o.status === "ready") setOverview(o.overview);
    setPenalties(p);
    setStatus(o.status);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <BudgetOverviewView
      locale={locale}
      status={status}
      overview={overview}
      penalties={penalties}
      onRefresh={() => void load()}
    />
  );
}
