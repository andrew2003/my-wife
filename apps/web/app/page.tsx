import { WakeCard } from "../components/wake-card";
import { translate } from "../lib/i18n";
import { getRequestLocale } from "../lib/request-context";

export default async function HomePage() {
  const locale = await getRequestLocale();
  return (
    <main>
      <h1>{translate(locale, "home.title")}</h1>
      <p>{translate(locale, "home.subtitle")}</p>
      <WakeCard locale={locale} />
      <p>
        <a href="/onboarding">{translate(locale, "onboarding.open")}</a>
      </p>
    </main>
  );
}
