import { WeekPlannerScreen } from "../../components/week-planner-screen";
import { translate } from "../../lib/i18n";
import { getRequestContext } from "../../lib/request-context";

export const dynamic = "force-dynamic";

export default async function WeekPlannerPage() {
  const { locale } = await getRequestContext();
  return (
    <main>
      <h1>{translate(locale, "weekplan.title")}</h1>
      <WeekPlannerScreen locale={locale} />
    </main>
  );
}
