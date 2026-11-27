import type { Locale, ModelRole } from "@my-wife/contracts";
import { renderMessage } from "../i18n";
import type { LlmProvider } from "../llm";

/** A question whose correct answer is a number or name computed by code from the user's data. */
export interface HandoverFact {
  /** Question id; the text lives in the locale files as `ai.handover.q.<id>`. */
  id: string;
  /** The code-computed value the answer must contain. */
  expected: string;
}

export interface HandoverResult {
  modelRole: ModelRole;
  state: "passed" | "failed";
  passRatio: number;
  failedQuestions: string[];
  /** Informational persona-voice score (0 to 1). It never gates the switch. */
  personaScore: number;
}

/** Strips separators and case so "1.250.000", "1,250,000" and "1250000" compare equal. */
const normalize = (text: string) => text.toLowerCase().replace(/[.,\s]/g, "");

/**
 * Runs the fixed handover questions against a candidate model. Grading is programmatic against
 * numbers computed by code (principle 4); the persona rubric is informational only (principle 3).
 */
export async function runHandoverTest(input: {
  provider: LlmProvider;
  facts: HandoverFact[];
  locale: Locale;
  role: ModelRole;
  passRatio: number;
}): Promise<HandoverResult> {
  const { provider, facts, locale } = input;
  const system = renderMessage(
    {
      key: "ai.persona.voice",
      params: {
        user: renderMessage({ key: "ai.persona.address.user", params: {} }, locale),
        self: renderMessage({ key: "ai.persona.address.self", params: {} }, locale),
      },
    },
    locale,
  );
  const selfWord = renderMessage({ key: "ai.persona.address.self", params: {} }, locale);
  const failed: string[] = [];
  let voiced = 0;
  for (const fact of facts) {
    const questionKey = `ai.handover.q.${fact.id}`;
    const userText = renderMessage({ key: questionKey, params: {} }, locale);
    if (userText === questionKey) {
      // No locale entry: the question cannot be asked, so it counts as failed (fail closed).
      failed.push(fact.id);
      continue;
    }
    try {
      const answer = await provider.complete({ system, userText, locale });
      if (!normalize(answer.text).includes(normalize(fact.expected))) failed.push(fact.id);
      if (answer.text.toLowerCase().includes(selfWord.toLowerCase())) voiced += 1;
    } catch {
      // A provider error counts as a failed answer; the message is dropped (it may quote a key).
      failed.push(fact.id);
    }
  }
  const total = facts.length;
  const ratio = total === 0 ? 1 : (total - failed.length) / total;
  return {
    modelRole: input.role,
    state: ratio >= input.passRatio ? "passed" : "failed",
    passRatio: ratio,
    failedQuestions: failed,
    personaScore: total === 0 ? 1 : voiced / total,
  };
}
