import type { Locale } from "@my-wife/contracts";
import { renderMessage } from "../i18n";

/** Basic persona: voice text and address terms come from the locale files. */
export function buildSystemPrompt(locale: Locale, memories: readonly string[] = []): string {
  const self = renderMessage({ key: "ai.persona.address.self", params: {} }, locale);
  const user = renderMessage({ key: "ai.persona.address.user", params: {} }, locale);
  const voice = renderMessage({ key: "ai.persona.voice", params: { self, user } }, locale);
  if (memories.length === 0) return voice;
  // Memories are stored data: listed under a header that says so, one per line.
  const header = renderMessage({ key: "ai.memory.header", params: {} }, locale);
  return [voice, header, ...memories.map((m) => `- ${m.replace(/\s+/g, " ")}`)].join("\n");
}
