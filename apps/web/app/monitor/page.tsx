import { CameraMonitor } from "../../components/camera-monitor";
import { translate } from "../../lib/i18n";
import { getRequestContext } from "../../lib/request-context";

export const dynamic = "force-dynamic";

export default async function MonitorPage({
  searchParams,
}: {
  searchParams: Promise<{ sessionId?: string }>;
}) {
  const { locale } = await getRequestContext();
  const { sessionId } = await searchParams;
  return (
    <main>
      <h1>{translate(locale, "monitor.title")}</h1>
      <CameraMonitor
        locale={locale}
        sessionId={sessionId ?? ""}
        forcedDelegate={process.env.CAMERA_ANALYSIS_DELEGATE}
      />
    </main>
  );
}
