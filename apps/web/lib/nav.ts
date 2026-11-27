export interface NavItem {
  href: string;
  labelKey: string;
}

/** Top-level destinations of the signed-in shell. Labels are locale keys. */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/", labelKey: "nav.home" },
  { href: "/schedule/today", labelKey: "nav.today" },
  { href: "/schedule", labelKey: "nav.schedule" },
  { href: "/schedule/calendar", labelKey: "nav.calendar" },
  { href: "/schedule/review", labelKey: "nav.review" },
  { href: "/budget", labelKey: "nav.budget" },
  { href: "/debts", labelKey: "nav.debts" },
  { href: "/cycle-close", labelKey: "nav.cycle_close" },
  { href: "/inbox", labelKey: "nav.inbox" },
  { href: "/anomalies", labelKey: "nav.anomalies" },
  { href: "/faults", labelKey: "nav.faults" },
  { href: "/penalties", labelKey: "nav.penalties" },
  { href: "/settings", labelKey: "nav.settings" },
];
