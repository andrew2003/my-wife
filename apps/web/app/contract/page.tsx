import { ContractPageScreen } from "../../components/contract-page-screen";
import { translate } from "../../lib/i18n";
import { getRequestContext } from "../../lib/request-context";

export const dynamic = "force-dynamic";

export default async function ContractPage() {
  const { locale } = await getRequestContext();
  return (
    <main>
      <h1>{translate(locale, "nav.contract")}</h1>
      <ContractPageScreen locale={locale} />
    </main>
  );
}
