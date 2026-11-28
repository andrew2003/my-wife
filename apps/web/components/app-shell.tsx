import type { ReactNode } from "react";
import { translate, type Locale } from "../lib/i18n";
import type { CurrentUser } from "../lib/session";
import { LocaleCookieSync } from "./locale-cookie-sync";
import { LocaleSwitch } from "./locale-switch";
import { ProductTour } from "./product-tour";
import { BottomBar, PillNav } from "./shell-nav";

/** Sticky translucent top bar: product name, account and language switch. */
function TopBar({ locale, user }: { locale: Locale; user: CurrentUser }) {
  return (
    <header className="shell-topbar">
      <strong>{translate(locale, "app.name")}</strong>
      <span className="shell-account">{user.email}</span>
      <LocaleSwitch locale={locale} />
    </header>
  );
}

export function AppShell({
  locale,
  user,
  children,
}: {
  locale: Locale;
  user: CurrentUser;
  children: ReactNode;
}) {
  return (
    <div className="shell">
      <TopBar locale={locale} user={user} />
      <PillNav locale={locale} role={user.role} />
      <div className="shell-content content">{children}</div>
      <BottomBar locale={locale} role={user.role} />
      <ProductTour locale={locale} />
      <LocaleCookieSync profileLocale={user.locale} />
    </div>
  );
}
