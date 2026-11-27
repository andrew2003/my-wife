"use client";

import type { FaultEntry } from "@my-wife/contracts";
import { useCallback, useEffect, useState } from "react";
import { loadTimeZone } from "../lib/budget-overview";
import { loadFaults, submitFaultAppeal } from "../lib/fault-ledger";
import type { Locale } from "../lib/i18n";
import {
  FaultLedgerView,
  type FaultAppealState,
  type FaultLedgerStatus,
} from "./fault-ledger-view";

/** Loads the fault ledger and the user's time zone, and runs the appeal form. */
export function FaultLedgerScreen({ locale }: { locale: Locale }) {
  const [status, setStatus] = useState<FaultLedgerStatus>("loading");
  const [faults, setFaults] = useState<FaultEntry[]>([]);
  const [timeZone, setTimeZone] = useState("UTC");
  const [appealingId, setAppealingId] = useState<string | null>(null);
  const [appealState, setAppealState] = useState<FaultAppealState>("idle");

  const load = useCallback(async () => {
    setStatus("loading");
    const [res, zone] = await Promise.all([loadFaults(), loadTimeZone()]);
    setTimeZone(zone);
    if (res.status === "ready") setFaults(res.faults);
    setStatus(res.status);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onSubmitAppeal = async (id: string, reason: string) => {
    setAppealState("sending");
    const ok = await submitFaultAppeal(id, reason);
    if (ok) {
      setAppealingId(null);
      await load();
    }
    setAppealState(ok ? "sent" : "failed");
  };

  return (
    <FaultLedgerView
      locale={locale}
      status={status}
      faults={faults}
      timeZone={timeZone}
      appealingId={appealingId}
      appealState={appealState}
      onAppeal={(id) => {
        setAppealingId(id);
        setAppealState("idle");
      }}
      onCancelAppeal={() => setAppealingId(null)}
      onSubmitAppeal={(id, reason) => void onSubmitAppeal(id, reason)}
      onRefresh={() => void load()}
    />
  );
}
