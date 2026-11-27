"use client";

import { useCallback, useEffect, useState } from "react";
import { loadTimeZone } from "../lib/budget-overview";
import { loadContractPage, signCycleContract, type ContractPageData } from "../lib/contract-page";
import type { Locale } from "../lib/i18n";
import { ContractPageView, type ContractPageStatus, type SignState } from "./contract-page-view";

/** Loads the open cycle's contract and rewards, and signs the contract. */
export function ContractPageScreen({ locale }: { locale: Locale }) {
  const [status, setStatus] = useState<ContractPageStatus>("loading");
  const [data, setData] = useState<ContractPageData | null>(null);
  const [timeZone, setTimeZone] = useState("UTC");
  const [agreed, setAgreed] = useState(false);
  const [signState, setSignState] = useState<SignState>("idle");

  const load = useCallback(async () => {
    setStatus("loading");
    const [res, zone] = await Promise.all([loadContractPage(), loadTimeZone()]);
    setTimeZone(zone);
    setData(res.status === "ready" ? res.data : null);
    setStatus(res.status);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onSign = async () => {
    if (!data) return;
    setSignState("sending");
    if (await signCycleContract(data.cycleId)) {
      setSignState("idle");
      setAgreed(false);
      await load();
    } else {
      setSignState("failed");
    }
  };

  return (
    <ContractPageView
      locale={locale}
      status={status}
      data={data}
      timeZone={timeZone}
      agreed={agreed}
      signState={signState}
      onAgreeChange={setAgreed}
      onSign={() => void onSign()}
      onRefresh={() => void load()}
    />
  );
}
