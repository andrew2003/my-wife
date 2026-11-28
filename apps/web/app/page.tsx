import { DashboardScreen } from "../components/dashboard-screen";
import { WakeCard } from "../components/wake-card";
import { artDirectory } from "../lib/art";
import { translate } from "../lib/i18n";
import { getRequestLocale } from "../lib/request-context";

export default async function HomePage() {
  const locale = await getRequestLocale();
  return (
    <main>
      <WakeCard locale={locale} />
      <DashboardScreen locale={locale} artAvailable={artDirectory(process.env) !== null} />
      <p>
        <a href="/onboarding">{translate(locale, "onboarding.open")}</a>
      </p>
    </main>
  );
}
