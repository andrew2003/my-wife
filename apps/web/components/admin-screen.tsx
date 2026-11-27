"use client";

import { useCallback, useEffect, useState } from "react";
import {
  adminAction,
  declareIncident,
  loadAdminData,
  type AdminAction,
  type AdminData,
  type IncidentDraft,
} from "../lib/admin";
import { loadTimeZone } from "../lib/budget-overview";
import type { Locale } from "../lib/i18n";
import { AdminView, type AdminStatus } from "./admin-view";

/** Loads the admin data and runs admin actions, then reloads. */
export function AdminScreen({ locale }: { locale: Locale }) {
  const [status, setStatus] = useState<AdminStatus>("loading");
  const [data, setData] = useState<AdminData | null>(null);
  const [timeZone, setTimeZone] = useState("UTC");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(false);

  const load = useCallback(async () => {
    setStatus("loading");
    const [res, zone] = await Promise.all([loadAdminData(), loadTimeZone()]);
    setTimeZone(zone);
    setData(res.status === "ready" ? res.data : null);
    setStatus(res.status);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (task: () => Promise<{ status: string }>) => {
    setBusy(true);
    setActionError(false);
    const res = await task();
    setBusy(false);
    if (res.status !== "done") setActionError(true);
    else await load();
  };

  return (
    <AdminView
      locale={locale}
      status={status}
      data={data}
      timeZone={timeZone}
      busy={busy}
      actionError={actionError}
      onRefresh={() => void load()}
      onAction={(a: AdminAction) => void run(() => adminAction(a))}
      onDeclare={(d: IncidentDraft) => void run(() => declareIncident(d))}
    />
  );
}
