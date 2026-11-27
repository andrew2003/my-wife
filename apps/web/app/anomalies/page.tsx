import { AnomalyListScreen } from "../../components/anomaly-list-screen";
import { translate } from "../../lib/i18n";
import { getRequestContext } from "../../lib/request-context";

export const dynamic = "force-dynamic";

export default async function AnomaliesPage() {
  const { locale } = await getRequestContext();
  return (
    <main>
      <h1>{translate(locale, "anomalies.title")}</h1>
      <AnomalyListScreen locale={locale} />
    </main>
  );
}
