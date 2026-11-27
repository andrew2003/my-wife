import { AdminScreen } from "../../components/admin-screen";
import { translate } from "../../lib/i18n";
import { getRequestContext } from "../../lib/request-context";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const { locale } = await getRequestContext();
  return (
    <main>
      <h1>{translate(locale, "admin.title")}</h1>
      <AdminScreen locale={locale} />
    </main>
  );
}
