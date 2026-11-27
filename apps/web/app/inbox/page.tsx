import { InboxScreen } from "../../components/inbox-screen";
import { translate } from "../../lib/i18n";
import { getRequestContext } from "../../lib/request-context";

export const dynamic = "force-dynamic";

export default async function InboxPage() {
  const { locale } = await getRequestContext();
  return (
    <main>
      <h1>{translate(locale, "inbox.title")}</h1>
      <InboxScreen locale={locale} />
    </main>
  );
}
