import { MonthCalendarScreen } from "../../../components/month-calendar-screen";
import { translate } from "../../../lib/i18n";
import { getRequestContext } from "../../../lib/request-context";

export const dynamic = "force-dynamic";

export default async function CalendarPage() {
  const { locale } = await getRequestContext();
  return (
    <main>
      <h1>{translate(locale, "calendar.title")}</h1>
      <MonthCalendarScreen locale={locale} />
    </main>
  );
}
