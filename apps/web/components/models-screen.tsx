"use client";

import type { LlmKeyView } from "@my-wife/contracts";
import { useCallback, useEffect, useState } from "react";
import type { Locale } from "../lib/i18n";
import {
  loadKeys,
  removeKey,
  switchModel,
  type HandoverResult,
  type SwitchInput,
} from "../lib/models";
import { ModelsView, type ModelsStatus, type SwitchState } from "./models-view";

/** Loads the masked key list and runs model switches; a switch reports its handover result. */
export function ModelsScreen({ locale }: { locale: Locale }) {
  const [status, setStatus] = useState<ModelsStatus>("loading");
  const [keys, setKeys] = useState<LlmKeyView[]>([]);
  const [switchState, setSwitchState] = useState<SwitchState>("idle");
  const [handover, setHandover] = useState<HandoverResult | null>(null);

  const load = useCallback(async () => {
    const res = await loadKeys();
    setKeys(res.status === "ready" ? res.keys : []);
    setStatus(res.status);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onSwitch = async (input: SwitchInput) => {
    setSwitchState("switching");
    setHandover(null);
    const res = await switchModel(input);
    if (res.status === "done") {
      setSwitchState("idle");
      setHandover(res.result);
      // A passed test stored the new key; a failed one left the old model active.
      await load();
    } else if (res.status === "refused") {
      setSwitchState(res.reason === "key_invalid" ? "refused_key_invalid" : "refused_not_ready");
    } else {
      setSwitchState("failed");
    }
  };

  const onRemove = async (keyId: string) => {
    if (await removeKey(keyId)) await load();
    else setSwitchState("failed");
  };

  return (
    <ModelsView
      locale={locale}
      status={status}
      keys={keys}
      switchState={switchState}
      handover={handover}
      onSwitch={(i) => void onSwitch(i)}
      onRemove={(id) => void onRemove(id)}
      onRefresh={() => {
        setStatus("loading");
        void load();
      }}
    />
  );
}
