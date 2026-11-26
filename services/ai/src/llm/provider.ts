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
}

/** One interface for every provider. Real providers arrive in M4 (MW-125). */
export interface LlmProvider {
  readonly id: string;
  complete(request: LlmRequest): Promise<LlmResponse>;
}
