import type { ExpressionState } from "./expressions";

export type ScreenStateKind = "loading" | "empty" | "error";

/** Locale keys of one screen's shared states. */
export interface ScreenStateKeys {
  loading: string;
  empty: string;
  error: string;
  retry: string;
}

/** Conventional keys `<ns>.loading`, `<ns>.empty`, `<ns>.error` and `<ns>.retry`. */
export function stateKeys(ns: string, overrides: Partial<ScreenStateKeys> = {}): ScreenStateKeys {
  return {
    loading: `${ns}.loading`,
    empty: `${ns}.empty`,
    error: `${ns}.error`,
    retry: `${ns}.retry`,
    ...overrides,
  };
}

/**
 * The expression state whose art stands in for an empty or error state. The user's
 * mapping and active set then decide the actual image.
 */
export function stateExpression(kind: Exclude<ScreenStateKind, "loading">): ExpressionState {
  return kind === "empty" ? "greeting" : "news";
}
