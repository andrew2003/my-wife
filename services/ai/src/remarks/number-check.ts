/** A fact the generated text may mention: code-computed, never produced by the model. */
export type RemarkFacts = Record<string, string | number>;

// A time (07:30), a grouped number (1.500.000 or 1,500,000), or a plain number with an optional
// decimal part. A date in a fact is compared by its parts, so it still passes.
const NUMBER_TOKEN = /\d{1,2}:\d{2}|\d{1,3}(?:[.,]\d{3})+(?!\d)|\d+(?:[.,]\d+)?/g;

/** Canonical form: thousands separators removed, a decimal comma turned into a point. */
function canonical(token: string): string {
  if (token.includes(":")) return token.padStart(5, "0");
  if (/^\d{1,3}([.,]\d{3})+$/.test(token)) return token.replace(/[.,]/g, "");
  return token.replace(",", ".");
}

function tokensOf(text: string): string[] {
  return (text.match(NUMBER_TOKEN) ?? []).map(canonical);
}

/**
 * Principle 4: every number, time and amount in the generated text must come from the supplied
 * facts. Values are compared in canonical form, so `1.500.000` equals `1500000`.
 */
export function checkNumbers(text: string, facts: RemarkFacts): boolean {
  const allowed = new Set<string>();
  for (const value of Object.values(facts)) {
    const raw = String(value);
    allowed.add(canonical(raw));
    for (const token of tokensOf(raw)) allowed.add(token);
  }
  return tokensOf(text).every((token) => allowed.has(token));
}
