import { PersonaScreen } from "../../../components/persona-screen";
import { translate } from "../../../lib/i18n";
import { getRequestContext } from "../../../lib/request-context";

export const dynamic = "force-dynamic";

export default async function PersonaPage() {
  const { locale } = await getRequestContext();
  return (
    <main>
      <h1>{translate(locale, "nav.persona")}</h1>
      <PersonaScreen locale={locale} />
    </main>
  );
}
