export type NavAreaId = "today" | "schedule" | "budget" | "routines" | "more";

export interface NavItem {
  href: string;
  labelKey: string;
  /** Only rendered for administrators; the API still enforces the role. */
  adminOnly?: boolean;
}

export interface NavArea {
  id: NavAreaId;
  labelKey: string;
  /** Page routes (Next.js notation, dynamic segments in brackets) owned by this area. */
  routes: readonly string[];
  /** Destinations offered in navigation; the first one is where the area tab links. */
  items: readonly NavItem[];
}

/** Routes that belong to no area: first-run flows with no navigation. */
export const EXCLUDED_ROUTES: readonly string[] = ["/onboarding"];

/** Five navigation areas. Every page route is in exactly one area or in EXCLUDED_ROUTES. */
export const NAV_AREAS: readonly NavArea[] = [
  {
    id: "today",
    labelKey: "nav.area.today",
    routes: ["/", "/schedule/today", "/monitor", "/inbox"],
    items: [
      { href: "/", labelKey: "nav.home" },
      { href: "/schedule/today", labelKey: "nav.today" },
      { href: "/inbox", labelKey: "nav.inbox" },
    ],
  },
  {
    id: "schedule",
    labelKey: "nav.schedule",
    routes: ["/schedule", "/schedule/review", "/schedule/calendar"],
    items: [
      { href: "/schedule", labelKey: "nav.schedule" },
      { href: "/schedule/calendar", labelKey: "nav.calendar" },
      { href: "/schedule/review", labelKey: "nav.review" },
    ],
  },
  {
    id: "budget",
    labelKey: "nav.budget",
    routes: [
      "/budget",
      "/budget/funding",
      "/anomalies",
      "/contract",
      "/penalties",
      "/debts",
      "/cycle-close",
      "/receipts/[id]",
    ],
    items: [
      { href: "/budget", labelKey: "nav.budget" },
      { href: "/debts", labelKey: "nav.debts" },
      { href: "/cycle-close", labelKey: "nav.cycle_close" },
      { href: "/anomalies", labelKey: "nav.anomalies" },
      { href: "/penalties", labelKey: "nav.penalties" },
      { href: "/contract", labelKey: "nav.contract" },
    ],
  },
  {
    id: "routines",
    labelKey: "nav.routines",
    routes: ["/routines", "/routines/sleep", "/faults"],
    items: [
      { href: "/routines", labelKey: "nav.routines" },
      { href: "/routines/sleep", labelKey: "nav.sleep" },
      { href: "/faults", labelKey: "nav.faults" },
    ],
  },
  {
    id: "more",
    labelKey: "shell.more",
    routes: ["/settings", "/settings/models", "/settings/privacy", "/credits", "/admin"],
    items: [
      { href: "/settings", labelKey: "nav.settings" },
      { href: "/settings/models", labelKey: "nav.models" },
      { href: "/settings/privacy", labelKey: "nav.privacy" },
      { href: "/credits", labelKey: "nav.credits" },
      { href: "/admin", labelKey: "nav.admin", adminOnly: true },
    ],
  },
];

/** Flat list of every destination, kept for callers that need all labels. */
export const NAV_ITEMS: readonly NavItem[] = NAV_AREAS.flatMap((a) => a.items);

function matches(pattern: string, path: string): boolean {
  const p = pattern.split("/");
  const s = path.split("/");
  return (
    p.length === s.length && p.every((seg, i) => (seg.startsWith("[") ? !!s[i] : seg === s[i]))
  );
}

/** The one area a concrete path belongs to, or null for excluded or unknown paths. */
export function areaForRoute(path: string): NavAreaId | null {
  const clean = path.length > 1 ? path.replace(/\/+$/, "") : path;
  return NAV_AREAS.find((a) => a.routes.some((r) => matches(r, clean)))?.id ?? null;
}

/** Areas with admin-only items removed unless the role is admin. */
export function visibleAreas(role: string): NavArea[] {
  return NAV_AREAS.map((a) => ({
    ...a,
    items: a.items.filter((i) => !i.adminOnly || role === "admin"),
  }));
}
