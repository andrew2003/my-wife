import { defaultLocale, translate } from "../lib/i18n";

export default function manifest() {
  const locale = defaultLocale(process.env.UI_LANGUAGE);
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
