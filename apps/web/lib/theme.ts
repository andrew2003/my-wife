/**
 * The single source of design tokens. `app/tokens.css` is generated from this
 * table (see `generateTokensCss`), and a test keeps the two in sync. Hex colors
 * are allowed only in this file and in the generated stylesheet.
 */

export const SKINS = ["navy", "hanfu", "silver", "street"] as const;
export const MODES = ["light", "dark", "system"] as const;
export type Skin = (typeof SKINS)[number];
export type Mode = (typeof MODES)[number];
export type ResolvedMode = Exclude<Mode, "system">;

export const SKIN_COOKIE = "mw_skin";
export const MODE_COOKIE = "mw_mode";
export const DEFAULT_SKIN: Skin = "navy";
export const DEFAULT_MODE: Mode = "system";

export function parseSkin(value: string | undefined): Skin {
  return SKINS.find((skin) => skin === value) ?? DEFAULT_SKIN;
}

export function parseMode(value: string | undefined): Mode {
  return MODES.find((mode) => mode === value) ?? DEFAULT_MODE;
}

interface Palette {
  bg: string;
  surface: string;
  text: string;
  muted: string;
  border: string;
  primary: string;
  onPrimary: string;
  accent: string;
  onAccent: string;
  focus: string;
  danger: string;
  success: string;
  warning: string;
}

/** Brand gold is decorative only: it fails contrast on light surfaces. */
const GOLD = "#C9A45C";

const LIGHT_BASE = {
  text: "#0B0B10",
  muted: "#4A5068",
  border: "#6B7390",
  surface: "#FFFFFF",
  onPrimary: "#FFFFFF",
  onAccent: "#FFFFFF",
  focus: "#2F5BB7",
  danger: "#B3261E",
  success: "#1B6E3A",
  warning: "#8A5A00",
};

const DARK_BASE = {
  text: "#F2F4FB",
  muted: "#B8BED6",
  border: "#8089B0",
  onPrimary: "#0B0B10",
  onAccent: "#0B0B10",
  focus: "#9CC3F0",
  danger: "#FF9A90",
  success: "#7FD99A",
  warning: "#F2C14E",
};

export const PALETTES: Record<Skin, Record<ResolvedMode, Palette>> = {
  navy: {
    light: { ...LIGHT_BASE, bg: "#F4F6FC", primary: "#16204A", accent: "#2F5BB7" },
    dark: {
      ...DARK_BASE,
      bg: "#0B1230",
      surface: "#141D44",
      primary: "#6FB6E8",
      accent: "#6FB6E8",
    },
  },
  hanfu: {
    light: { ...LIGHT_BASE, bg: "#F8F6F1", primary: "#27407F", accent: "#3F63B5" },
    dark: {
      ...DARK_BASE,
      bg: "#0F1A3A",
      surface: "#18254D",
      primary: "#9CC3F0",
      accent: "#9CC3F0",
    },
  },
  silver: {
    light: { ...LIGHT_BASE, bg: "#F3F4F8", primary: "#3443B8", accent: "#4C5BCB" },
    dark: {
      ...DARK_BASE,
      bg: "#12142B",
      surface: "#1C1F3D",
      primary: "#A3ADFF",
      accent: "#A3ADFF",
    },
  },
  street: {
    light: { ...LIGHT_BASE, bg: "#F2F2F4", primary: "#0B0B10", accent: "#2F54EB" },
    dark: {
      ...DARK_BASE,
      bg: "#0B0B10",
      surface: "#17171F",
      primary: "#FFFFFF",
      accent: "#7B93FF",
    },
  },
};

/** Values shared by every skin and mode. */
const STATIC_TOKENS: Record<string, string> = {
  "--mw-color-gold": GOLD,
  "--mw-radius-card": "24px",
  "--mw-radius-control": "999px",
  "--mw-space-1": "4px",
  "--mw-space-2": "8px",
  "--mw-space-3": "12px",
  "--mw-space-4": "16px",
  "--mw-space-6": "24px",
  "--mw-space-8": "32px",
  "--mw-shadow-card": "0 2px 12px rgb(11 11 16 / 0.12)",
  "--mw-motion-fast": "120ms",
  "--mw-motion-base": "200ms",
  "--mw-layout-max": "72rem",
  "--mw-touch-min": "44px",
  "--mw-font-ui": '"Be Vietnam Pro", system-ui, sans-serif',
  "--mw-font-title": '"Playfair Display", Georgia, serif',
};

const COLOR_VARS: Record<keyof Palette, string> = {
  bg: "--mw-color-bg",
  surface: "--mw-color-surface",
  text: "--mw-color-text",
  muted: "--mw-color-muted",
  border: "--mw-color-border",
  primary: "--mw-color-primary",
  onPrimary: "--mw-color-on-primary",
  accent: "--mw-color-accent",
  onAccent: "--mw-color-on-accent",
  focus: "--mw-color-focus",
  danger: "--mw-color-danger",
  success: "--mw-color-success",
  warning: "--mw-color-warning",
};

export interface ContrastPair {
  name: string;
  foreground: string;
  background: string;
  minimum: number;
}

/** Every text, control boundary and focus pair that must meet WCAG AA. */
export function requiredPairs(skin: Skin, mode: ResolvedMode): ContrastPair[] {
  const p = PALETTES[skin][mode];
  const text = 4.5;
  const nonText = 3;
  return [
    { name: "text on bg", foreground: p.text, background: p.bg, minimum: text },
    { name: "text on surface", foreground: p.text, background: p.surface, minimum: text },
    { name: "muted on bg", foreground: p.muted, background: p.bg, minimum: text },
    { name: "muted on surface", foreground: p.muted, background: p.surface, minimum: text },
    {
      name: "on-primary on primary",
      foreground: p.onPrimary,
      background: p.primary,
      minimum: text,
    },
    { name: "on-accent on accent", foreground: p.onAccent, background: p.accent, minimum: text },
    { name: "primary text on bg", foreground: p.primary, background: p.bg, minimum: text },
    {
      name: "primary text on surface",
      foreground: p.primary,
      background: p.surface,
      minimum: text,
    },
    {
      name: "accent control on surface",
      foreground: p.accent,
      background: p.surface,
      minimum: nonText,
    },
    { name: "primary control on bg", foreground: p.primary, background: p.bg, minimum: nonText },
    { name: "accent control on bg", foreground: p.accent, background: p.bg, minimum: nonText },
    { name: "border on bg", foreground: p.border, background: p.bg, minimum: nonText },
    { name: "border on surface", foreground: p.border, background: p.surface, minimum: nonText },
    { name: "focus ring on bg", foreground: p.focus, background: p.bg, minimum: nonText },
    { name: "focus ring on surface", foreground: p.focus, background: p.surface, minimum: nonText },
    { name: "danger on surface", foreground: p.danger, background: p.surface, minimum: text },
    { name: "danger on bg", foreground: p.danger, background: p.bg, minimum: text },
    { name: "success on surface", foreground: p.success, background: p.surface, minimum: text },
    { name: "success on bg", foreground: p.success, background: p.bg, minimum: text },
    { name: "warning on surface", foreground: p.warning, background: p.surface, minimum: text },
    { name: "warning on bg", foreground: p.warning, background: p.bg, minimum: text },
  ];
}

function channel(value: number): number {
  const s = value / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  );
}

/** WCAG 2.x contrast ratio of two `#RRGGBB` colors. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Browser chrome colors for `viewport.themeColor`. */
export function themeColors(skin: Skin): { light: string; dark: string } {
  return { light: PALETTES[skin].light.bg, dark: PALETTES[skin].dark.bg };
}

function declarations(palette: Palette, indent: string): string {
  return (Object.keys(COLOR_VARS) as (keyof Palette)[])
    .map((key) => `${indent}${COLOR_VARS[key]}: ${palette[key]};`)
    .join("\n");
}

/** The stylesheet written to `app/tokens.css`. */
export function generateTokensCss(): string {
  const blocks: string[] = [
    "/* Generated from lib/theme.ts by `pnpm --filter @my-wife/web tokens`. Do not edit. */",
    `:root {\n${Object.entries(STATIC_TOKENS)
      .map(([k, v]) => `  ${k}: ${v};`)
      .join("\n")}\n  color-scheme: light dark;\n}`,
  ];
  // Light is the base for every skin; the default skin also covers a missing attribute.
  blocks.push(
    `:root,\n${SKINS.map((s) => `[data-skin="${s}"]`).join(",\n")} {\n  color-scheme: light;\n}`,
  );
  blocks.push(`:root {\n${declarations(PALETTES[DEFAULT_SKIN].light, "  ")}\n}`);
  for (const skin of SKINS) {
    blocks.push(`[data-skin="${skin}"] {\n${declarations(PALETTES[skin].light, "  ")}\n}`);
  }
  // System mode: no data-mode attribute, so the media query decides.
  blocks.push(
    `@media (prefers-color-scheme: dark) {\n  :root:not([data-mode]) {\n    color-scheme: dark;\n${declarations(PALETTES[DEFAULT_SKIN].dark, "    ")}\n  }\n${SKINS.map(
      (skin) =>
        `  [data-skin="${skin}"]:not([data-mode]) {\n    color-scheme: dark;\n${declarations(PALETTES[skin].dark, "    ")}\n  }`,
    ).join("\n")}\n}`,
  );
  for (const skin of SKINS) {
    blocks.push(
      `[data-skin="${skin}"][data-mode="dark"] {\n  color-scheme: dark;\n${declarations(PALETTES[skin].dark, "  ")}\n}`,
    );
  }
  blocks.push(
    `:root[data-mode="dark"]:not([data-skin]) {\n  color-scheme: dark;\n${declarations(PALETTES[DEFAULT_SKIN].dark, "  ")}\n}`,
  );
  blocks.push(
    "@media (prefers-reduced-motion: reduce) {\n  :root {\n    --mw-motion-fast: 0ms;\n    --mw-motion-base: 0ms;\n  }\n}",
  );
  return `${blocks.join("\n\n")}\n`;
}
