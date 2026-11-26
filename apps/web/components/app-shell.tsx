import type { ReactNode } from "react";
import { NAV_ITEMS } from "../lib/nav";
import { translate, type Locale } from "../lib/i18n";
import type { CurrentUser } from "../lib/session";
import { LocaleSwitch } from "./locale-switch";
import { ProductTour } from "./product-tour";

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
      <header>
        <strong>{translate(locale, "app.name")}</strong>
        <span>{user.email}</span>
        <LocaleSwitch locale={locale} />
      </header>
      <nav aria-label={translate(locale, "nav.label")}>
        <ul>
          {NAV_ITEMS.map((item) => (
            <li key={item.href}>
              <a href={item.href}>{translate(locale, item.labelKey)}</a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="content">{children}</div>
      <ProductTour locale={locale} />
    </div>
  );
}
