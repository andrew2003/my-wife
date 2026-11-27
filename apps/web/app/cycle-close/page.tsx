import { CycleCloseScreen } from "../../components/cycle-close-screen";
import { translate } from "../../lib/i18n";
import { getRequestContext } from "../../lib/request-context";

export const dynamic = "force-dynamic";

export default async function CycleClosePage() {
  const { locale } = await getRequestContext();
  return (
    <main>
      <h1>{translate(locale, "cycle_close.title")}</h1>
      <CycleCloseScreen locale={locale} />
    </main>
  );
}
