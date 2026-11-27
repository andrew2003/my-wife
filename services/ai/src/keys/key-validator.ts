import type { LlmKeyView } from "@my-wife/contracts";

/** Provider ids from the contract: anthropic, openai, google, openrouter and other (openai-compatible). */
export type LlmProvider = LlmKeyView["provider"];

export interface KeyCheck {
  provider: LlmProvider;
  model: string;
  apiKey: string;
}

/**
 * Port that decides whether a provider accepts a key. Real network checks per provider
 * (anthropic, openai, google, openai-compatible) plug in here; tests use fakes.
 */
export interface KeyValidator {
  validate(check: KeyCheck): Promise<boolean>;
}

/** Smallest plausible key length accepted by the offline validator. */
const MIN_KEY_LENGTH = 8;

/** Offline default: a shape check only. It never sends the key anywhere. */
export function createKeyValidator(): KeyValidator {
  return {
    validate: async ({ apiKey }) => apiKey.trim().length >= MIN_KEY_LENGTH && !/\s/.test(apiKey),
  };
}
