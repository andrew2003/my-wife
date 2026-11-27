"use client";

import { useCallback, useEffect, useState } from "react";
import { loadTimeZone } from "../lib/budget-overview";
import type { Locale } from "../lib/i18n";
import {
  answerInboxQuestion,
  loadInbox,
  loadReadIds,
  saveReadIds,
  type InboxFilter,
  type InboxItem,
} from "../lib/inbox";
import { InboxView, type InboxStatus } from "./inbox-view";

/** Loads the inbox, keeps read state on this device and sends replies. */
export function InboxScreen({ locale }: { locale: Locale }) {
  const [status, setStatus] = useState<InboxStatus>("loading");
  const [items, setItems] = useState<InboxItem[]>([]);
  const [filter, setFilter] = useState<InboxFilter>({});
  const [timeZone, setTimeZone] = useState("UTC");
  const [readIds, setReadIds] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [replyError, setReplyError] = useState(false);

  const load = useCallback(async (next: InboxFilter) => {
    setStatus("loading");
    const [res, zone] = await Promise.all([loadInbox(next), loadTimeZone()]);
    setTimeZone(zone);
    setItems(res.status === "ready" ? res.items : []);
    setStatus(res.status);
  }, []);

  useEffect(() => {
    setReadIds(loadReadIds(window.localStorage));
  }, []);
  useEffect(() => {
    void load(filter);
  }, [load, filter]);

  const markRead = (id: string) => {
    const next = new Set(readIds).add(id);
    setReadIds(next);
    saveReadIds(window.localStorage, next);
  };

  const answer = async (questionId: string, value: string) => {
    setBusyId(questionId);
    setReplyError(false);
    const res = await answerInboxQuestion(questionId, value);
    setBusyId(null);
    if (res.status === "error") setReplyError(true);
    else await load(filter);
  };

  return (
    <InboxView
      locale={locale}
      status={status}
      items={items}
      readIds={readIds}
      now={new Date()}
      timeZone={timeZone}
      filter={filter}
      busyId={busyId}
      replyError={replyError}
      onFilter={setFilter}
      onRefresh={() => void load(filter)}
      onMarkRead={markRead}
      onAnswer={(id, value) => void answer(id, value)}
    />
  );
}
