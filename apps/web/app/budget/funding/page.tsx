import { FundingScreen } from "../../../components/funding-screen";
import { translate } from "../../../lib/i18n";
import { getRequestContext } from "../../../lib/request-context";

export const dynamic = "force-dynamic";

export default async function FundingPage() {
  const { locale } = await getRequestContext();
  return (
    <main>
      <h1>{translate(locale, "funding.title")}</h1>
      <FundingScreen locale={locale} />
    </main>
  );
}
