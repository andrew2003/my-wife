"use client";

import type { PenaltyLedgerEntry } from "@my-wife/contracts";
import { useCallback, useEffect, useState } from "react";
import { loadTimeZone } from "../lib/budget-overview";
import type { Locale } from "../lib/i18n";
import { loadLedger, submitAppeal } from "../lib/penalty-ledger";
import { PenaltyLedgerView, type AppealState, type LedgerStatus } from "./penalty-ledger-view";

/** Loads the ledger and the user's time zone, and runs the appeal form. */
export function PenaltyLedgerScreen({ locale }: { locale: Locale }) {
  const [status, setStatus] = useState<LedgerStatus>("loading");
  const [penalties, setPenalties] = useState<PenaltyLedgerEntry[]>([]);
  const [timeZone, setTimeZone] = useState("UTC");
  const [appealingId, setAppealingId] = useState<string | null>(null);
  const [appealState, setAppealState] = useState<AppealState>("idle");

  const load = useCallback(async () => {
    setStatus("loading");
    const [res, zone] = await Promise.all([loadLedger(), loadTimeZone()]);
    setTimeZone(zone);
    if (res.status === "ready") setPenalties(res.penalties);
    setStatus(res.status);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onSubmitAppeal = async (id: string, reason: string) => {
    setAppealState("sending");
    const penalty = penalties.find((p) => p.id === id);
    const ok = penalty ? await submitAppeal(penalty, reason) : false;
    if (ok) setAppealingId(null);
    setAppealState(ok ? "sent" : "failed");
  };

  return (
    <PenaltyLedgerView
      locale={locale}
      status={status}
      penalties={penalties}
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
