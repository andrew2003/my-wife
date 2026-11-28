import { translate, type Locale } from "../lib/i18n";
import { Mascot } from "./mascot";
import { SpeechBubble } from "./speech-bubble";

export type CompanionStatus = "loading" | "ready" | "error";

/** Character and a speech bubble: the remark, typing dots, or the fixed fallback sentence. */
export function CompanionPanelView({
  locale,
  status,
  text,
  artAvailable,
}: {
  locale: Locale;
  status: CompanionStatus;
  text?: string;
  artAvailable: boolean;
}) {
  const shown =
    status === "ready" && text
      ? text
      : status === "loading"
        ? undefined
        : translate(locale, "companion.fallback");
  return (
    <aside className="companion-panel" aria-label={translate(locale, "companion.label")}>
      <SpeechBubble
        {...(shown ? { text: shown } : {})}
        typingLabel={translate(locale, "companion.loading")}
      />
      <Mascot
        artKey="chibi-greet"
        size="medium"
        alt={translate(locale, "companion.art_alt")}
        available={artAvailable}
      />
    </aside>
  );
}
