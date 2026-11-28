"use client";

import { useCallback, useEffect, useState } from "react";
import {
  loadOverview,
  loadPenalties,
  loadTimeZone,
  type Overview,
  type PenaltiesResult,
} from "../lib/budget-overview";
import { loadTransferList, type FundingResult } from "../lib/funding";
import type { Locale } from "../lib/i18n";
import { BudgetOverviewView, type OverviewStatus } from "./budget-overview-view";

/** Loads the overview and the due penalties; a penalty failure never hides the overview. */
export function BudgetOverviewScreen({ locale }: { locale: Locale }) {
  const [status, setStatus] = useState<OverviewStatus>("loading");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [penalties, setPenalties] = useState<PenaltiesResult>({ status: "loading" });

  const [timeZone, setTimeZone] = useState<string>("UTC");
  const [transfers, setTransfers] = useState<FundingResult>({ status: "empty" });

  const load = useCallback(async () => {
    setStatus("loading");
    const [o, p, zone, tl] = await Promise.all([
      loadOverview(),
      loadPenalties(),
      loadTimeZone(),
      loadTransferList(),
    ]);
    setTimeZone(zone);
    setTransfers(tl);
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
      transfers={transfers}
      timeZone={timeZone}
      onRefresh={() => void load()}
    />
  );
}
