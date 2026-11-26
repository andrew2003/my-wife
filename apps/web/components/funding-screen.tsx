"use client";

import { useCallback, useEffect, useState } from "react";
import { loadFunding, type FundingAccount } from "../lib/funding";
import type { Locale } from "../lib/i18n";
import { FundingView, type FundingStatus } from "./funding-view";

/** Seconds between automatic refreshes while the screen is open. */
const REFRESH_SECONDS = 15;

/** Loads the funding list and refreshes it, so a verified receipt flips the account to funded. */
export function FundingScreen({ locale }: { locale: Locale }) {
  const [status, setStatus] = useState<FundingStatus>("loading");
  const [accounts, setAccounts] = useState<FundingAccount[]>([]);

  const load = useCallback(async (initial: boolean) => {
    if (initial) setStatus("loading");
    const res = await loadFunding();
    if (res.status === "ready") setAccounts(res.accounts);
    setStatus(res.status);
  }, []);

  useEffect(() => {
    void load(true);
    const timer = setInterval(() => void load(false), REFRESH_SECONDS * 1000);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <FundingView
      locale={locale}
      status={status}
      accounts={accounts}
      onRefresh={() => void load(true)}
    />
  );
}
