"use client";

import { useCallback, useEffect, useState } from "react";
import type { Locale } from "../lib/i18n";
import { acceptSuggestion, loadReview, type Review } from "../lib/weekly-review";
import { WeeklyReviewView, type WeeklyReviewStatus } from "./weekly-review-view";

/** Loads the weekly review and accepts its suggestions. */
export function WeeklyReviewScreen({ locale, weekId }: { locale: Locale; weekId?: string }) {
  const [status, setStatus] = useState<WeeklyReviewStatus>("loading");
  const [review, setReview] = useState<Review | null>(null);
  const [accepted, setAccepted] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await loadReview(weekId);
    if (res.status === "ready") setReview(res.review);
    setStatus(res.status);
  }, [weekId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onAccept = async (kind: string) => {
    const suggestion = review?.suggestions.find((s) => s.kind === kind);
    if (!review || !suggestion) return;
    setBusy(true);
    setErrorKey(null);
    const res = await acceptSuggestion(review.weekId, suggestion);
    if (res.ok) setAccepted((a) => [...a, kind]);
    else setErrorKey(res.errorKey);
    setBusy(false);
  };

  return (
    <WeeklyReviewView
      locale={locale}
      status={status}
      review={review}
      accepted={accepted}
      busy={busy}
      errorKey={errorKey}
      onAccept={(kind) => void onAccept(kind)}
      onRetry={() => {
        setStatus("loading");
        void refresh();
      }}
    />
  );
}
