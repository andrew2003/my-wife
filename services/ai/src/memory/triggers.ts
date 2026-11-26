import en from "../locales/en.json";
import vi from "../locales/vi.json";

const KEY = "ai.memory.remember_triggers";

/** Trigger phrases of an explicit "remember ..." request, from every locale file, longest first. */
export function rememberTriggers(): string[] {
  const phrases = [en, vi].flatMap(
    (catalog) => (catalog as Record<string, string>)[KEY]?.split("|") ?? [],
  );
  return [...new Set(phrases.map((p) => p.trim().toLowerCase()).filter((p) => p !== ""))].sort(
    (a, b) => b.length - a.length,
  );
}

/**
 * The fact of a message that starts with a trigger phrase, or null. The trigger must end at a word
 * boundary; the rest of the message, without leading punctuation, is the fact.
 */
export function extractExplicitFact(text: string, triggers: readonly string[]): string | null {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  for (const trigger of triggers) {
    if (!lower.startsWith(trigger)) continue;
    const rest = trimmed.slice(trigger.length);
    if (rest !== "" && !/^[\s:,.-]/.test(rest)) continue;
    const fact = rest.replace(/^[\s:,.-]+/, "").replace(/\s+/g, " ");
    return fact === "" ? null : fact;
  }
  return null;
}
