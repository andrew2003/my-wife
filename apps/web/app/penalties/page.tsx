import { PenaltyLedgerScreen } from "../../components/penalty-ledger-screen";
import { translate } from "../../lib/i18n";
import { getRequestContext } from "../../lib/request-context";

export const dynamic = "force-dynamic";

export default async function PenaltiesPage() {
  const { locale } = await getRequestContext();
  return (
    <main>
      <h1>{translate(locale, "penalty.title")}</h1>
      <PenaltyLedgerScreen locale={locale} />
    </main>
  );
}
