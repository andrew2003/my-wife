import { SETTINGS } from "@my-wife/contracts";
import { FocusSessionScreen } from "../../components/focus-session-screen";
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
      <FocusSessionScreen
        locale={locale}
        sessionId={sessionId ?? ""}
        // No settings read path exists in the web app yet; use the registry default for now.
        heartbeatEverySeconds={SETTINGS["monitor.heartbeat_interval_seconds"].default}
        forcedDelegate={process.env.CAMERA_ANALYSIS_DELEGATE}
      />
    </main>
  );
}
