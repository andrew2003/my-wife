"use client";

import type { Debt } from "@my-wife/contracts";
import { useCallback, useEffect, useState } from "react";
import { loadTimeZone } from "../lib/budget-overview";
import { loadDebts } from "../lib/debts";
import type { Locale } from "../lib/i18n";
import { DebtsView, type DebtsStatus } from "./debts-view";

/** Loads open debts and the user's time zone. */
export function DebtsScreen({ locale }: { locale: Locale }) {
  const [status, setStatus] = useState<DebtsStatus>("loading");
  const [debts, setDebts] = useState<Debt[]>([]);
  const [timeZone, setTimeZone] = useState("UTC");

  const load = useCallback(async () => {
    setStatus("loading");
    const [res, zone] = await Promise.all([loadDebts(), loadTimeZone()]);
    setTimeZone(zone);
    if (res.status === "ready") setDebts(res.debts);
    setStatus(res.status);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <DebtsView
      locale={locale}
      status={status}
      debts={debts}
      timeZone={timeZone}
      onRefresh={() => void load()}
    />
  );
}
