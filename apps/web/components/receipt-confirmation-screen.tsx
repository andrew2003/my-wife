"use client";

import type { ReceiptParsedPayload, ReceiptState } from "@my-wife/contracts";
import { useCallback, useEffect, useState } from "react";
import { loadTimeZone } from "../lib/budget-overview";
import type { Locale } from "../lib/i18n";
import { confirmReceipt, loadReceipt } from "../lib/receipt-confirmation";
import {
  ReceiptConfirmationView,
  type ReceiptOutcome,
  type ReceiptStatus,
} from "./receipt-confirmation-view";

/** Loads one receipt and posts the user's confirm or reject. */
export function ReceiptConfirmationScreen({
  locale,
  receiptId,
}: {
  locale: Locale;
  receiptId: string;
}) {
  const [status, setStatus] = useState<ReceiptStatus>("loading");
  const [state, setState] = useState<ReceiptState | null>(null);
  const [receipt, setReceipt] = useState<ReceiptParsedPayload | null>(null);
  const [timeZone, setTimeZone] = useState("UTC");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ReceiptOutcome>(null);

  const load = useCallback(async () => {
    setStatus("loading");
    const [res, zone] = await Promise.all([loadReceipt(receiptId), loadTimeZone()]);
    setTimeZone(zone);
    if (res.status === "ready") {
      setState(res.state);
      setReceipt(res.receipt);
    }
    setStatus(res.status);
  }, [receiptId]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (accept: boolean) => {
    setBusy(true);
    const done = await confirmReceipt(receiptId, accept);
    setBusy(false);
    if (!done) {
      setOutcome("failed");
      return;
    }
    setOutcome(accept ? "confirmed" : "rejected");
    setState(accept ? "parsed" : "rejected");
  };

  return (
    <ReceiptConfirmationView
      locale={locale}
      status={status}
      state={state}
      receipt={receipt}
      timeZone={timeZone}
      busy={busy}
      outcome={outcome}
      onConfirm={() => void act(true)}
      onReject={() => void act(false)}
      onRetry={() => void load()}
    />
  );
}
