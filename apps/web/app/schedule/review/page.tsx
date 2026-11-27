import { WeeklyReviewScreen } from "../../../components/weekly-review-screen";
import { translate } from "../../../lib/i18n";
import { getRequestContext } from "../../../lib/request-context";

export const dynamic = "force-dynamic";

export default async function WeeklyReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}) {
  const { locale } = await getRequestContext();
  const { week } = await searchParams;
  return (
    <main>
      <h1>{translate(locale, "review.title")}</h1>
      <WeeklyReviewScreen locale={locale} weekId={week} />
    </main>
  );
}
