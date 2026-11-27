"use client";

import { useCallback, useEffect, useState } from "react";
import type { ConsentKind } from "@my-wife/contracts";
import type { Locale } from "../lib/i18n";
import {
  grantConsent,
  loadConsents,
  requestDeletion,
  requestExport,
  revokeConsent,
  type ConsentRecord,
} from "../lib/privacy";
import {
  PrivacyView,
  type DeletionState,
  type ExportState,
  type PrivacyStatus,
} from "./privacy-view";

/** Loads consents and runs grant, revoke, export and deletion against identity. */
export function PrivacyScreen({ locale }: { locale: Locale }) {
  const [status, setStatus] = useState<PrivacyStatus>("loading");
  const [consents, setConsents] = useState<ConsentRecord[]>([]);
  const [exportState, setExportState] = useState<ExportState>({ status: "idle" });
  const [deletionState, setDeletionState] = useState<DeletionState>("idle");
  const [confirmOpen, setConfirmOpen] = useState(false);

  const load = useCallback(async () => {
    const res = await loadConsents();
    setConsents(res.status === "ready" ? res.consents : []);
    setStatus(res.status);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const change = async (run: () => Promise<boolean>) => {
    if (await run()) await load();
    else setStatus("error");
  };

  return (
    <PrivacyView
      locale={locale}
      status={status}
      consents={consents}
      exportState={exportState}
      deletionState={deletionState}
      confirmOpen={confirmOpen}
      onGrant={(k) => void change(() => grantConsent(k as ConsentKind))}
      onRevoke={(k) => void change(() => revokeConsent(k as ConsentKind))}
      onExport={() => {
        setExportState({ status: "working" });
        void requestExport().then(setExportState);
      }}
      onOpenConfirm={() => setConfirmOpen(true)}
      onCancelConfirm={() => {
        setConfirmOpen(false);
        setDeletionState("idle");
      }}
      onDelete={(confirmation) => {
        setDeletionState("working");
        void requestDeletion(confirmation).then((res) =>
          setDeletionState(
            res.status === "done"
              ? res.state
              : res.status === "not_confirmed"
                ? "not_confirmed"
                : "failed",
          ),
        );
      }}
      onRefresh={() => {
        setStatus("loading");
        void load();
      }}
    />
  );
}
