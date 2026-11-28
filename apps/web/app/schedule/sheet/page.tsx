import { TimetableSheetScreen } from "../../../components/timetable-sheet-screen";
import { translate } from "../../../lib/i18n";
import { getRequestContext } from "../../../lib/request-context";

export const dynamic = "force-dynamic";

export default async function TimetableSheetPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}) {
  const { locale } = await getRequestContext();
  const { week } = await searchParams;
  return (
    <main>
      <h1>{translate(locale, "sheet.title")}</h1>
      <TimetableSheetScreen locale={locale} weekId={week} />
    </main>
  );
}
