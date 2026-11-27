import { localMidnight } from "./rule-change";
import type { ContractStore } from "./contract";

export type OpenedCycle = {
  cycleId: string;
  /** Local calendar day the cycle starts on (`YYYY-MM-DD`). */
  firstDay: string;
};

export type CycleContractStatus = {
  /** True while the open cycle has no signed contract: the user must (re-)sign. */
  contractRequired: boolean;
  /** Loosening cannot take effect before this instant; null once the cycle is over. */
  looseningLockedUntil: string | null;
};

/** Start of the cycle after the one that began on `firstDay`, at local midnight. */
export function nextCycleStart(firstDay: string, cycleWeeks: number, timeZone: string): Date {
  return localMidnight(firstDay, timeZone, cycleWeeks * 7);
}

/**
 * Pure decision for an opened cycle: a contract is required until one is signed for this
 * cycle, and loosening stays locked until the next cycle starts.
 */
export function evaluateCycleContract(
  input: { cycle: OpenedCycle; signed: boolean; cycleWeeks: number; timeZone: string },
  now: Date,
): CycleContractStatus {
  const end = nextCycleStart(input.cycle.firstDay, input.cycleWeeks, input.timeZone);
  const open = now.getTime() < end.getTime();
  return {
    // Once the cycle is over nothing is owed for it; the next cycle.opened brings its own.
    contractRequired: open && !input.signed,
    looseningLockedUntil: open ? end.toISOString() : null,
  };
}

export interface CycleContractStore {
  latest(userId: string): OpenedCycle | undefined;
  save(userId: string, cycle: OpenedCycle): void;
}

export class InMemoryCycleContractStore implements CycleContractStore {
  private readonly rows = new Map<string, OpenedCycle>();
  latest(userId: string) {
    return this.rows.get(userId);
  }
  save(userId: string, cycle: OpenedCycle) {
    this.rows.set(userId, Object.freeze({ ...cycle }));
  }
}

export type CycleContractServiceDeps = {
  store: CycleContractStore;
  contracts: ContractStore;
  /** Per-user `budget.cycle_weeks` and `calendar.time_zone`; defaults come from the registry. */
  readSettings: (userId: string) => { cycleWeeks: number; timeZone: string };
};

export function createCycleContractService(deps: CycleContractServiceDeps) {
  return {
    /**
     * `cycle.opened`: the newest cycle wins; redelivery, late older cycles and a different
     * cycle id on the same first day (the first one seen wins) change nothing.
     */
    onCycleOpened(userId: string, cycle: OpenedCycle) {
      const current = deps.store.latest(userId);
      if (current && current.firstDay >= cycle.firstDay) return;
      deps.store.save(userId, cycle);
    },
    status(userId: string, now: Date): (CycleContractStatus & { cycleId: string }) | undefined {
      const cycle = deps.store.latest(userId);
      if (!cycle) return undefined;
      const { cycleWeeks, timeZone } = deps.readSettings(userId);
      const signed = deps.contracts.findSigned(userId, cycle.cycleId) !== undefined;
      return {
        cycleId: cycle.cycleId,
        ...evaluateCycleContract({ cycle, signed, cycleWeeks, timeZone }, now),
      };
    },
    /** Instant until which loosening is locked for the user, if a cycle is open. */
    looseningLockedUntil(userId: string, now: Date): string | undefined {
      return this.status(userId, now)?.looseningLockedUntil ?? undefined;
    },
  };
}
