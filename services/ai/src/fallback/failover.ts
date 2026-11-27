import type { DegradedReasonSchema } from "@my-wife/contracts";

export type DegradedReason = ReturnType<(typeof DegradedReasonSchema)["parse"]>;

export type ModelSlot = "primary" | "fallback";

/** Consecutive-failure bookkeeping for one user. Pure data; see `nextFailoverState`. */
export interface FailoverState {
  primaryFailures: number;
  fallbackFailures: number;
  /** The model that answers the next message while not degraded. */
  active: ModelSlot;
  degraded: boolean;
  reason: DegradedReason | null;
  /** True once the user was told the backup model is answering. */
  notified: boolean;
}

export const INITIAL_FAILOVER: FailoverState = {
  primaryFailures: 0,
  fallbackFailures: 0,
  active: "primary",
  degraded: false,
  reason: null,
  notified: false,
};

export interface FailoverOutcomeOptions {
  /** False when the user has no fallback model; then primary failures alone degrade. */
  hasFallback?: boolean;
  reason?: DegradedReason;
}

/**
 * Applies one model call result. The counter is per slot and resets on success (decisions.md,
 * M4 audit). After `threshold` consecutive primary failures the fallback takes over; when the
 * last available model also reaches `threshold` the service is degraded. Any success leaves
 * degraded mode.
 */
export function nextFailoverState(
  state: FailoverState,
  slot: ModelSlot,
  ok: boolean,
  threshold: number,
  options: FailoverOutcomeOptions = {},
): FailoverState {
  const hasFallback = options.hasFallback ?? true;
  if (ok) {
    return {
      ...state,
      primaryFailures: slot === "primary" ? 0 : state.primaryFailures,
      fallbackFailures: 0,
      active: slot,
      degraded: false,
      reason: null,
      notified: slot === "primary" ? false : state.notified,
    };
  }
  const next = { ...state, reason: options.reason ?? "provider_down" };
  if (slot === "primary") {
    next.primaryFailures = state.primaryFailures + 1;
    if (next.primaryFailures >= threshold && hasFallback) next.active = "fallback";
    if (next.primaryFailures >= threshold && !hasFallback) next.degraded = true;
  } else {
    next.fallbackFailures = state.fallbackFailures + 1;
    if (next.fallbackFailures >= threshold) next.degraded = true;
  }
  return next;
}
