import { ModelsScreen } from "../../../components/models-screen";
import { translate } from "../../../lib/i18n";
import { getRequestContext } from "../../../lib/request-context";

export const dynamic = "force-dynamic";

export default async function ModelsPage() {
  const { locale } = await getRequestContext();
  return (
    <main>
      <h1>{translate(locale, "nav.models")}</h1>
      <ModelsScreen locale={locale} />
    </main>
  );
}
