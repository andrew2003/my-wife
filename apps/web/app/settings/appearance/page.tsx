import { AppearanceScreen } from "../../../components/appearance-screen";
import { translate } from "../../../lib/i18n";
import { getRequestContext } from "../../../lib/request-context";

export const dynamic = "force-dynamic";

export default async function AppearancePage() {
  const { locale, appearance } = await getRequestContext();
  return (
    <main>
      <h1>{translate(locale, "nav.appearance")}</h1>
      <AppearanceScreen locale={locale} current={appearance} />
    </main>
  );
}
