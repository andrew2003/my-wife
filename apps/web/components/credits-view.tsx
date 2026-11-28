import { translate, type Locale } from "../lib/i18n";

/** Credits text from the private directory, or a generic note when there is none. */
export function CreditsView({ locale, credits }: { locale: Locale; credits: string | null }) {
  return credits ? (
    <p className="credits-text">{credits}</p>
  ) : (
    <p className="credits-note">{translate(locale, "credits.generic_note")}</p>
  );
}
