import { ExpressionsScreen } from "../../../components/expressions-screen";
import { artDirectory } from "../../../lib/art";
import { translate } from "../../../lib/i18n";
import { getRequestContext } from "../../../lib/request-context";

export const dynamic = "force-dynamic";

export default async function ExpressionsPage() {
  const { locale } = await getRequestContext();
  return (
    <main>
      <h1>{translate(locale, "nav.expressions")}</h1>
      <ExpressionsScreen locale={locale} artAvailable={artDirectory(process.env) !== null} />
    </main>
  );
}
