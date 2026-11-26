import { OnboardingWizard } from "../../components/onboarding-wizard";
import { getRequestContext } from "../../lib/request-context";

export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const { locale } = await getRequestContext();
  return <OnboardingWizard locale={locale} />;
}
