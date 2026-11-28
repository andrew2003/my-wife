import { BudgetSheetScreen } from "../../../components/budget-sheet-screen";
import { translate } from "../../../lib/i18n";
import { getRequestContext } from "../../../lib/request-context";

export const dynamic = "force-dynamic";

export default async function BudgetSheetPage() {
  const { locale } = await getRequestContext();
  return (
    <main>
      <h1>{translate(locale, "budgetsheet.title")}</h1>
      <BudgetSheetScreen locale={locale} />
    </main>
  );
}
