import { CommandsScreen } from "../../../components/commands-screen";
import { translate } from "../../../lib/i18n";
import { getRequestContext } from "../../../lib/request-context";

export const dynamic = "force-dynamic";

export default async function CommandsPage() {
  const { locale } = await getRequestContext();
  return (
    <main>
      <h1>{translate(locale, "nav.commands")}</h1>
      <CommandsScreen locale={locale} />
    </main>
  );
}
