"use client";

import { usePathname } from "next/navigation";
import { useState } from "react";
import { areaForRoute, visibleAreas, type NavArea } from "../lib/nav";
import { translate, type Locale } from "../lib/i18n";
import { Sheet } from "./ui";

interface NavProps {
  locale: Locale;
  role: string;
}

function useActiveArea() {
  const pathname = usePathname();
  return { pathname, active: pathname ? areaForRoute(pathname) : null };
}

function areaHref(area: NavArea): string {
  return area.items[0]?.href ?? "/";
}

/** Desktop navigation: one pill per area, then the pages of the active area. */
export function PillNav({ locale, role }: NavProps) {
  const { pathname, active } = useActiveArea();
  const areas = visibleAreas(role);
  const current = areas.find((a) => a.id === active);
  return (
    <nav className="pill-nav" aria-label={translate(locale, "nav.label")}>
      <ul className="pill-list">
        {areas.map((a) => (
          <li key={a.id}>
            <a
              href={areaHref(a)}
              className="pill"
              aria-current={a.id === active ? "page" : undefined}
            >
              {translate(locale, a.labelKey)}
            </a>
          </li>
        ))}
      </ul>
      {current && current.items.length > 1 ? (
        <ul className="pill-sub" aria-label={translate(locale, "shell.area_nav")}>
          {current.items.map((i) => (
            <li key={i.href}>
              <a href={i.href} aria-current={i.href === pathname ? "page" : undefined}>
                {translate(locale, i.labelKey)}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </nav>
  );
}

/** Phone navigation: a tab per area plus a More button that opens a sheet with every page. */
export function BottomBar({ locale, role }: NavProps) {
  const { pathname, active } = useActiveArea();
  const [open, setOpen] = useState(false);
  const areas = visibleAreas(role);
  const tabs = areas.filter((a) => a.id !== "more");
  return (
    <>
      <nav className="bottom-bar" aria-label={translate(locale, "nav.label")}>
        <ul>
          {tabs.map((a) => (
            <li key={a.id}>
              <a href={areaHref(a)} aria-current={a.id === active ? "page" : undefined}>
                {translate(locale, a.labelKey)}
              </a>
            </li>
          ))}
          <li>
            <button
              type="button"
              aria-haspopup="dialog"
              aria-expanded={open}
              aria-current={active === "more" ? "page" : undefined}
              onClick={() => setOpen(true)}
            >
              {translate(locale, "shell.more")}
            </button>
          </li>
        </ul>
      </nav>
      <Sheet
        open={open}
        title={translate(locale, "shell.more_title")}
        closeLabel={translate(locale, "shell.close")}
        onClose={() => setOpen(false)}
      >
        <div className="more-sheet">
          {areas.map((a) => (
            <section key={a.id}>
              <h3>{translate(locale, a.labelKey)}</h3>
              <ul>
                {a.items.map((i) => (
                  <li key={i.href}>
                    <a href={i.href} aria-current={i.href === pathname ? "page" : undefined}>
                      {translate(locale, i.labelKey)}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </Sheet>
    </>
  );
}
