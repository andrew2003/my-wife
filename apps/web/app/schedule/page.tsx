import { ScheduleScreen } from "../../components/schedule-screen";
import { translate } from "../../lib/i18n";
import { getRequestContext } from "../../lib/request-context";

export const dynamic = "force-dynamic";

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; day?: string }>;
}) {
  const { locale } = await getRequestContext();
  const { tab, day } = await searchParams;
  return (
    <main>
      <h1>{translate(locale, "schedule.title")}</h1>
      <ScheduleScreen locale={locale} initialTab={tab} initialDay={day} />
    </main>
  );
}
