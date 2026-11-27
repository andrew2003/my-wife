import { RoutinesScreen } from "../../components/routines-screen";
import { translate } from "../../lib/i18n";
import { getRequestContext } from "../../lib/request-context";

export const dynamic = "force-dynamic";

export default async function RoutinesPage() {
  const { locale } = await getRequestContext();
  return (
    <main>
      <h1>{translate(locale, "nav.routines")}</h1>
      <RoutinesScreen locale={locale} kind="levels" />
    </main>
  );
}
