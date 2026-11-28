import { translate, type Locale } from "../lib/i18n";
import type { ClaimState, MenuResult, ProjectedSurplus, WishlistResult } from "../lib/cycle-close";
import { ScreenState, stateKeys } from "./screen-state";

const CYCLE_CLOSE_STATE_KEYS = stateKeys("cycle_close");

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

  if (status === "loading")
    return <ScreenState locale={locale} kind="loading" keys={CYCLE_CLOSE_STATE_KEYS} />;
  if (status === "empty")
    return <ScreenState locale={locale} kind="empty" keys={CYCLE_CLOSE_STATE_KEYS} />;
  if (status === "error") {
    return (
      <ScreenState
        locale={locale}
        kind="error"
        keys={CYCLE_CLOSE_STATE_KEYS}
        onRetry={props.onRefresh}
      />
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
      {wishlist.status === "loading" && (
        <ScreenState locale={locale} kind="loading" keys={CYCLE_CLOSE_STATE_KEYS} height="4rem" />
      )}
      {wishlist.status === "empty" && (
        <ScreenState
          locale={locale}
          kind="empty"
          keys={stateKeys("cycle_close", { empty: "cycle_close.wishlist.empty" })}
        />
      )}
      {wishlist.status === "error" && (
        <ScreenState
          locale={locale}
          kind="error"
          keys={stateKeys("cycle_close", { error: "cycle_close.wishlist.error" })}
          onRetry={props.onRefresh}
        />
      )}
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
      {menu.status === "loading" && (
        <ScreenState locale={locale} kind="loading" keys={CYCLE_CLOSE_STATE_KEYS} height="4rem" />
      )}
      {menu.status === "empty" && (
        <ScreenState
          locale={locale}
          kind="empty"
          keys={stateKeys("cycle_close", { empty: "cycle_close.menu.empty" })}
        />
      )}
      {menu.status === "error" && (
        <ScreenState
          locale={locale}
          kind="error"
          keys={stateKeys("cycle_close", { error: "cycle_close.menu.error" })}
          onRetry={props.onRefresh}
        />
      )}
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
