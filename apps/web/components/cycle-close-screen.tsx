"use client";

import { useCallback, useEffect, useState } from "react";
import { loadOverview } from "../lib/budget-overview";
import {
  claimException,
  exceptionsPerCycle,
  loadCloseSettings,
  loadWeeklyMenu,
  loadWishlist,
  projectSurplus,
  type ClaimState,
  type CloseOverview,
  type CloseSettings,
  type MenuResult,
  type WishlistResult,
} from "../lib/cycle-close";
import type { Locale } from "../lib/i18n";
import { CycleCloseView, type CycleCloseStatus } from "./cycle-close-view";

/** Loads the closing cycle, the wishlist and the weekly menu; a side failure never hides the rest. */
export function CycleCloseScreen({ locale }: { locale: Locale }) {
  const [status, setStatus] = useState<CycleCloseStatus>("loading");
  const [overview, setOverview] = useState<CloseOverview | null>(null);
  const [settings, setSettings] = useState<CloseSettings>({});
  const [wishlist, setWishlist] = useState<WishlistResult | { status: "loading" }>({
    status: "loading",
  });
  const [menu, setMenu] = useState<MenuResult | { status: "loading" }>({ status: "loading" });
  const [claim, setClaim] = useState<ClaimState>({ state: "idle" });

  const load = useCallback(async () => {
    setStatus("loading");
    setWishlist({ status: "loading" });
    setMenu({ status: "loading" });
    setClaim({ state: "idle" });
    const [o, values, w] = await Promise.all([loadOverview(), loadCloseSettings(), loadWishlist()]);
    setSettings(values);
    setWishlist(w);
    if (o.status === "ready") {
      setOverview(o.overview);
      setMenu(await loadWeeklyMenu(o.overview.weekIndex));
    }
    setStatus(o.status);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onClaim = async (categoryId: string) => {
    if (!overview) return;
    setClaim({ state: "busy" });
    setClaim(await claimException(categoryId, overview.weekIndex));
  };

  return (
    <CycleCloseView
      locale={locale}
      status={status}
      surplus={overview ? projectSurplus(overview, settings) : null}
      exceptionsPerCycle={exceptionsPerCycle(settings)}
      claimable={(overview?.categories ?? [])
        .filter((c) => c.category.kind === "variable")
        .map((c) => ({ id: c.category.id, name: c.category.name }))}
      wishlist={wishlist}
      menu={menu}
      claim={claim}
      onClaim={(id) => void onClaim(id)}
      onRefresh={() => void load()}
    />
  );
}
