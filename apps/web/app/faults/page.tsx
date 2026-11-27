import { FaultLedgerScreen } from "../../components/fault-ledger-screen";
import { translate } from "../../lib/i18n";
import { getRequestContext } from "../../lib/request-context";

export const dynamic = "force-dynamic";

export default async function FaultsPage() {
  const { locale } = await getRequestContext();
  return (
    <main>
      <h1>{translate(locale, "fault.title")}</h1>
      <FaultLedgerScreen locale={locale} />
    </main>
  );
}
