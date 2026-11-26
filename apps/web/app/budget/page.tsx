import { BudgetOverviewScreen } from "../../components/budget-overview-screen";
import { translate } from "../../lib/i18n";
import { getRequestContext } from "../../lib/request-context";

export const dynamic = "force-dynamic";

export default async function BudgetPage() {
  const { locale } = await getRequestContext();
  return (
    <main>
      <h1>{translate(locale, "budget.title")}</h1>
      <BudgetOverviewScreen locale={locale} />
    </main>
  );
}
