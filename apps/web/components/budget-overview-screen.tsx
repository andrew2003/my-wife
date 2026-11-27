"use client";

import { useCallback, useEffect, useState } from "react";
import {
  loadOverview,
  loadPenalties,
  loadTimeZone,
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

  const [timeZone, setTimeZone] = useState<string>("UTC");

  const load = useCallback(async () => {
    setStatus("loading");
    const [o, p, zone] = await Promise.all([loadOverview(), loadPenalties(), loadTimeZone()]);
    setTimeZone(zone);
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
      timeZone={timeZone}
      onRefresh={() => void load()}
    />
  );
}
