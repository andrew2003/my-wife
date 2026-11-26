import { translate, type Locale } from "../lib/i18n";

export function LocaleSwitch({ locale }: { locale: Locale }) {
  const other: Locale = locale === "vi" ? "en" : "vi";
  return (
    <a href={`/locale?to=${other}`} lang={other}>
      {translate(locale, `locale.switch_to_${other}`)}
    </a>
  );
}
