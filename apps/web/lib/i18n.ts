import en from "../locales/en.json";
import vi from "../locales/vi.json";

export type Locale = "vi" | "en";

const catalogs: Record<Locale, Record<string, string>> = { vi, en };

/** UI_LANGUAGE picks the default locale; anything else falls back to Vietnamese. */
export function defaultLocale(value: string | undefined): Locale {
  return value === "en" || value === "vi" ? value : "vi";
}

/** The one place UI_LANGUAGE is read: the fallback when nothing else decides. */
export function configuredLocale(): Locale {
  return defaultLocale(process.env.UI_LANGUAGE);
}

export function translate(
  locale: Locale,
  key: string,
  params: Record<string, string | number> = {},
): string {
  const template = catalogs[locale][key];
  if (template === undefined) return key;
  return template.replace(/\{(\w+)\}/g, (_, p: string) => String(params[p] ?? `{${p}}`));
}
