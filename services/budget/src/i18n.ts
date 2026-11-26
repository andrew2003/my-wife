import type { Locale } from "@my-wife/contracts";
import en from "./locales/en.json";
import vi from "./locales/vi.json";

const CATALOGS: Record<Locale, Record<string, string>> = { en, vi };

/** Looks up a locale key; falls back to `en`, then to the key itself. */
export function t(key: string, locale: Locale): string {
  return CATALOGS[locale][key] ?? CATALOGS.en[key] ?? key;
}
