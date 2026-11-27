import { PrivacyScreen } from "../../../components/privacy-screen";
import { translate } from "../../../lib/i18n";
import { getRequestContext } from "../../../lib/request-context";

export const dynamic = "force-dynamic";

export default async function PrivacyPage() {
  const { locale } = await getRequestContext();
  return (
    <main>
      <h1>{translate(locale, "nav.privacy")}</h1>
      <PrivacyScreen locale={locale} />
    </main>
  );
}
