import type { LlmProvider, LlmRequest, LlmResponse } from "./provider";

export interface FakeProviderOptions {
  /** Builds the reply; defaults to echoing the user text. */
  reply?: (request: LlmRequest) => LlmResponse;
  /** When true every call fails, to simulate an unavailable provider. */
  unavailable?: boolean;
}

/** Deterministic provider used in M1 and in tests. It never calls the network. */
export class FakeLlmProvider implements LlmProvider {
  readonly id = "fake";
  readonly requests: LlmRequest[] = [];
  constructor(private readonly options: FakeProviderOptions = {}) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    if (this.options.unavailable) throw new Error("provider unavailable");
    if (this.options.reply) return this.options.reply(request);
    return { text: request.userText, toolCalls: [] };
  }
}
