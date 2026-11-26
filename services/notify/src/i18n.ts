import type { Locale, MessageRef } from "@my-wife/contracts";
import en from "./locales/en.json";
import vi from "./locales/vi.json";

const CATALOGS: Record<Locale, Record<string, string>> = { en, vi };

/** Renders a locale key with `{param}` placeholders; falls back to `en`, then to the key. */
export function renderMessage(ref: MessageRef, locale: Locale): string {
  const template = CATALOGS[locale][ref.key] ?? CATALOGS.en[ref.key] ?? ref.key;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in ref.params ? String(ref.params[name]) : whole,
  );
}
