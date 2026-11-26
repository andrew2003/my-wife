import { defaultLocale, translate } from "../lib/i18n";

export default function HomePage() {
  const locale = defaultLocale(process.env.UI_LANGUAGE);
  return (
    <main>
      <h1>{translate(locale, "home.title")}</h1>
      <p>{translate(locale, "home.subtitle")}</p>
    </main>
  );
}
