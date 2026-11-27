import type { Locale } from "@my-wife/contracts";
import { renderMessage } from "../i18n";

/** Basic persona: voice text and address terms come from the locale files. */
export function buildSystemPrompt(
  locale: Locale,
  memories: readonly string[] = [],
  summaries: readonly string[] = [],
): string {
  const self = renderMessage({ key: "ai.persona.address.self", params: {} }, locale);
  const user = renderMessage({ key: "ai.persona.address.user", params: {} }, locale);
  const voice = renderMessage({ key: "ai.persona.voice", params: { self, user } }, locale);
  const lines = [voice];
  const bullet = (m: string) => `- ${m.replace(/\s+/g, " ")}`;
  // Memories are stored data: listed under a header that says so, one per line.
  if (memories.length > 0) {
    lines.push(
      renderMessage({ key: "ai.memory.header", params: {} }, locale),
      ...memories.map(bullet),
    );
  }
  // Summaries are model-written and informational only; they never count as confirmed facts.
  if (summaries.length > 0) {
    lines.push(
      renderMessage({ key: "ai.summary.header", params: {} }, locale),
      ...summaries.map(bullet),
    );
  }
  return lines.join("\n");
}
