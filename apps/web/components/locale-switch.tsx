import { translate, type Locale } from "../lib/i18n";

const LANGUAGES: Array<{ id: Locale; label: string }> = [
  { id: "vi", label: "VI" },
  { id: "en", label: "EN" },
];

/** Segmented VI | EN control; the active language is highlighted. */
export function LocaleSwitch({ locale }: { locale: Locale }) {
  return (
    <div role="group" aria-label={translate(locale, "locale.group")} className="locale-switch">
      {LANGUAGES.map(({ id, label }) => (
        <a
          key={id}
          href={`/locale?lang=${id}`}
          lang={id}
          aria-pressed={id === locale}
          data-active={id === locale}
        >
          {label}
        </a>
      ))}
    </div>
  );
}
