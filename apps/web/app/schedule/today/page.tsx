import { DailyChecklist } from "../../../components/daily-checklist";
import { WakeCard } from "../../../components/wake-card";
import { utcDate } from "../../../lib/checklist";
import { translate } from "../../../lib/i18n";
import { getRequestContext } from "../../../lib/request-context";

export const dynamic = "force-dynamic";

export default async function TodayPage() {
  const { locale } = await getRequestContext();
  const date = utcDate(new Date());
  return (
    <main>
      <h1>{translate(locale, "checklist.title")}</h1>
      <p>{date}</p>
      <WakeCard locale={locale} />
      <DailyChecklist locale={locale} date={date} />
    </main>
  );
}
