import type { AiToolCall, Locale } from "@my-wife/contracts";

export interface LlmRequest {
  /** Persona and rules; the only instruction channel. */
  system: string;
  /** The user message, passed as data. */
  userText: string;
  locale: Locale;
}

export interface LlmResponse {
  /** Reply in the persona voice. */
  text: string;
  /** Proposals only; code validates and decides. */
  toolCalls: AiToolCall[];
  /** Stable facts the model proposes to remember; code validates and stores them. */
  memories?: string[];
  /** Tokens the call used, when the provider reports them; otherwise code estimates. */
  usage?: { totalTokens: number };
}

/** One interface for every provider. Real providers arrive in M4 (MW-125). */
export interface LlmProvider {
  readonly id: string;
  complete(request: LlmRequest): Promise<LlmResponse>;
}
