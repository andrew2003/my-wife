import { configuredLocale, translate } from "../lib/i18n";

/** A manifest has no user context, so it uses the configured default language. */
export default function manifest() {
  const locale = configuredLocale();
  return {
    name: translate(locale, "app.name"),
    short_name: translate(locale, "app.name"),
    description: translate(locale, "app.description"),
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [],
  };
}
