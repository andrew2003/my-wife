"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { loadRemark, remarkScreen, showsCompanion } from "../lib/companion";
import type { Locale } from "../lib/i18n";
import { CompanionPanelView, type CompanionStatus } from "./companion-panel-view";

/** Loads the remark of the current screen; renders nothing on the dashboard and focus session. */
export function CompanionPanel({
  locale,
  artAvailable,
}: {
  locale: Locale;
  artAvailable: boolean;
}) {
  // No router context (a bare render) counts as the dashboard: no panel.
  const pathname = usePathname() ?? "/";
  const visible = showsCompanion(pathname);
  const screen = remarkScreen(pathname);
  const [state, setState] = useState<{ screen: string; status: CompanionStatus; text?: string }>({
    screen,
    status: "loading",
  });

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setState({ screen, status: "loading" });
    void loadRemark(screen, locale).then((res) => {
      if (cancelled) return;
      setState(
        res.status === "ready"
          ? { screen, status: "ready", text: res.text }
          : { screen, status: "error" },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [visible, screen, locale]);

  if (!visible) return null;
  // A stale remark from the previous screen is never shown while the new one loads.
  const current = state.screen === screen ? state : { screen, status: "loading" as const };
  return (
    <CompanionPanelView
      locale={locale}
      status={current.status}
      {...(current.text ? { text: current.text } : {})}
      artAvailable={artAvailable}
    />
  );
}
