import { CreditsView } from "../../components/credits-view";
import { FallbackArt } from "../../components/mascot";
import { artDirectory, readCredits } from "../../lib/art";
import { translate } from "../../lib/i18n";
import { getRequestContext } from "../../lib/request-context";

export const dynamic = "force-dynamic";

export default async function CreditsPage() {
  const { locale } = await getRequestContext();
  const dir = artDirectory(process.env);
  const credits = await readCredits(dir);
  return (
    <main>
      <h1>{translate(locale, "nav.credits")}</h1>
      {dir ? null : <FallbackArt />}
      <CreditsView locale={locale} credits={credits} />
    </main>
  );
}
