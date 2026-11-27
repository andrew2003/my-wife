import { translate, type Locale } from "../lib/i18n";
import type { ClaimState, MenuResult, ProjectedSurplus, WishlistResult } from "../lib/cycle-close";

export type CycleCloseStatus = "loading" | "ready" | "empty" | "error";

export interface CycleCloseViewProps {
  locale: Locale;
  status: CycleCloseStatus;
  surplus: ProjectedSurplus | null;
  exceptionsPerCycle: number;
  /** Variable categories an exception can be claimed for this week. */
  claimable: { id: string; name: string }[];
  wishlist: WishlistResult | { status: "loading" };
  menu: MenuResult | { status: "loading" };
  claim: ClaimState;
  onClaim: (categoryId: string) => void;
  onRefresh: () => void;
}

/** Presentational page of a closing cycle: surplus split, exceptions, wishlist and weekly menu. */
export function CycleCloseView(props: CycleCloseViewProps) {
  const { locale, status, surplus, claimable, wishlist, menu, claim } = props;
  const t = (key: string, params?: Record<string, string | number>) =>
    translate(locale, key, params);
  const tag = locale === "vi" ? "vi-VN" : "en-US";
  const money = (vnd: number) =>
    `${new Intl.NumberFormat(tag).format(vnd)} ${t("cycle_close.currency")}`;

  if (status === "loading") return <p role="status">{t("cycle_close.loading")}</p>;
  if (status === "empty") return <p>{t("cycle_close.empty")}</p>;
  if (status === "error") {
    return (
      <div>
        <p role="alert">{t("cycle_close.error")}</p>
        <button type="button" className="button" onClick={props.onRefresh}>
          {t("cycle_close.retry")}
        </button>
      </div>
    );
  }

  const surplusSection = surplus && (
    <section aria-label={t("cycle_close.surplus.title")}>
      <h2>{t("cycle_close.surplus.title")}</h2>
      <p>{t("cycle_close.surplus.note")}</p>
      <ul className="penalty-list">
        <li className="penalty-entry">
          {t("cycle_close.surplus.total")} <strong>{money(surplus.totalVnd)}</strong>
        </li>
        <li className="penalty-entry">
          {t("cycle_close.surplus.savings")} {money(surplus.savingsVnd)}
        </li>
        <li className="penalty-entry">
          {t("cycle_close.surplus.future")} {money(surplus.futurePurchasesVnd)}
        </li>
        <li className="penalty-entry">
          {t("cycle_close.surplus.remainder", {
            target: t(`cycle_close.target.${surplus.remainderTarget}`),
          })}{" "}
          {money(surplus.remainderVnd)}
        </li>
      </ul>
    </section>
  );

  const claimMessage =
    claim.state === "done"
      ? t("cycle_close.exceptions.claimed", { remaining: claim.remaining })
      : claim.state === "failed"
        ? t(`cycle_close.exceptions.failed.${claim.code}`) ===
          `cycle_close.exceptions.failed.${claim.code}`
          ? t("cycle_close.exceptions.failed.unknown")
          : t(`cycle_close.exceptions.failed.${claim.code}`)
        : null;

  const exceptionsSection = (
    <section aria-label={t("cycle_close.exceptions.title")}>
      <h2>{t("cycle_close.exceptions.title")}</h2>
      <p>{t("cycle_close.exceptions.intro", { limit: props.exceptionsPerCycle })}</p>
      {props.exceptionsPerCycle === 0 ? (
        <p>{t("cycle_close.exceptions.none_allowed")}</p>
      ) : claimable.length === 0 ? (
        <p>{t("cycle_close.exceptions.no_categories")}</p>
      ) : (
        <ul className="penalty-list">
          {claimable.map((c) => (
            <li key={c.id} className="penalty-entry">
              <span>{c.name}</span>{" "}
              <button
                type="button"
                className="button"
                disabled={claim.state === "busy"}
                onClick={() => props.onClaim(c.id)}
              >
                {t("cycle_close.exceptions.claim")}
              </button>
            </li>
          ))}
        </ul>
      )}
      {claimMessage && <p role="status">{claimMessage}</p>}
    </section>
  );

  const wishlistSection = (
    <section aria-label={t("cycle_close.wishlist.title")}>
      <h2>{t("cycle_close.wishlist.title")}</h2>
      {wishlist.status === "loading" && <p role="status">{t("cycle_close.loading")}</p>}
      {wishlist.status === "empty" && <p>{t("cycle_close.wishlist.empty")}</p>}
      {wishlist.status === "error" && <p role="alert">{t("cycle_close.wishlist.error")}</p>}
      {wishlist.status === "ready" && (
        <ul className="penalty-list">
          {wishlist.items.map((i) => (
            <li key={i.id} className="penalty-entry">
              <p>
                <strong>{i.name}</strong>
              </p>
              <p>
                {money(i.savedVnd)} / {money(i.priceVnd)} ({i.progressPercent}%)
              </p>
              <progress max={100} value={i.progressPercent} aria-label={i.name} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  const menuSection = (
    <section aria-label={t("cycle_close.menu.title")}>
      <h2>{t("cycle_close.menu.title")}</h2>
      {menu.status === "loading" && <p role="status">{t("cycle_close.loading")}</p>}
      {menu.status === "empty" && <p>{t("cycle_close.menu.empty")}</p>}
      {menu.status === "error" && <p role="alert">{t("cycle_close.menu.error")}</p>}
      {menu.status === "ready" && (
        <div>
          <ul className="penalty-list">
            {menu.menu.menu.map((d) => (
              <li key={d.day} className="penalty-entry">
                {t("cycle_close.menu.day", { day: d.day })}: {d.dishes.join(", ")}
              </li>
            ))}
          </ul>
          <h3>{t("cycle_close.menu.shopping")}</h3>
          <ul className="penalty-list">
            {menu.menu.shoppingList.map((l) => (
              <li key={`${l.name}|${l.unit}`} className="penalty-entry">
                {l.name} {l.quantity} {l.unit}
                {l.estimatedCostVnd !== null && ` - ${money(l.estimatedCostVnd)}`}
              </li>
            ))}
          </ul>
          {menu.menu.totalEstimateVnd !== null && (
            <p>
              {t("cycle_close.menu.estimate", {
                total: money(menu.menu.totalEstimateVnd),
                limit: money(menu.menu.limitVnd),
              })}
            </p>
          )}
          {menu.menu.trimmedMeals > 0 && (
            <p>{t("cycle_close.menu.trimmed", { count: menu.menu.trimmedMeals })}</p>
          )}
        </div>
      )}
    </section>
  );

  return (
    <div>
      <p>{t("cycle_close.intro")}</p>
      {surplusSection}
      {exceptionsSection}
      {wishlistSection}
      {menuSection}
      <button type="button" className="button" onClick={props.onRefresh}>
        {t("cycle_close.refresh")}
      </button>
    </div>
  );
}
