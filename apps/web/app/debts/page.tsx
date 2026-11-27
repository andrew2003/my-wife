import { DebtsScreen } from "../../components/debts-screen";
import { translate } from "../../lib/i18n";
import { getRequestContext } from "../../lib/request-context";

export const dynamic = "force-dynamic";

export default async function DebtsPage() {
  const { locale } = await getRequestContext();
  return (
    <main>
      <h1>{translate(locale, "debts.title")}</h1>
      <DebtsScreen locale={locale} />
    </main>
  );
}
