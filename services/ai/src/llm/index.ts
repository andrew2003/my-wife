import { FakeLlmProvider } from "./fake-provider";
import type { LlmProvider } from "./provider";

/** Until M4 (MW-125) only the fake provider exists; no key storage is implemented. */
export function createProvider(id: string = "fake"): LlmProvider {
  if (id !== "fake") throw new Error(`provider not available before M4: ${id}`);
  return new FakeLlmProvider();
}
export { FakeLlmProvider } from "./fake-provider";
export type { LlmProvider, LlmRequest, LlmResponse } from "./provider";
