import type { Locale } from "@my-wife/contracts";
import { renderMessage } from "../i18n";

/** Basic persona: voice text and address terms come from the locale files. */
export function buildSystemPrompt(locale: Locale): string {
  const self = renderMessage({ key: "ai.persona.address.self", params: {} }, locale);
  const user = renderMessage({ key: "ai.persona.address.user", params: {} }, locale);
  return renderMessage({ key: "ai.persona.voice", params: { self, user } }, locale);
}
