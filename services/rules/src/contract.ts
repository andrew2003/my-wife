import { randomUUID } from "node:crypto";
import {
  EVENT_SCHEMA_VERSION,
  type CommitmentContractSchema,
  type EventEnvelope,
  type EventPayload,
} from "@my-wife/contracts";

export type CommitmentContract = (typeof CommitmentContractSchema)["_output"];
export type ContractSummary = CommitmentContract["summary"];

type StoredContract = {
  userId: string;
  contract: CommitmentContract;
  /** Set once contract.signed was published; null means the event is still owed. */
  eventPublishedAt: string | null;
  /** True while one caller is publishing; guards against a concurrent second publish. */
  eventClaimed: boolean;
};

export interface ContractStore {
  findSigned(userId: string, cycleId: string): CommitmentContract | undefined;
  /** Atomically claims the owed event of the contract; undefined if none is owed or it is claimed. */
  claimOwedEvent(userId: string, cycleId: string): CommitmentContract | undefined;
  releaseEventClaim(contractId: string): void;
  latestVersion(userId: string, cycleId: string): number;
  save(userId: string, contract: CommitmentContract): void;
  markEventPublished(contractId: string, at: string): void;
}

/** Signed contracts are immutable: the store has no update, only save and a publish marker. */
export class InMemoryContractStore implements ContractStore {
  private readonly rows: StoredContract[] = [];

  findSigned(userId: string, cycleId: string) {
    return this.latest(userId, cycleId)?.contract;
  }
  // Synchronous check-and-set: no await between the test and the write.
  claimOwedEvent(userId: string, cycleId: string) {
    const row = this.latest(userId, cycleId);
    if (!row || row.eventPublishedAt !== null || row.eventClaimed) return undefined;
    row.eventClaimed = true;
    return row.contract;
  }
  releaseEventClaim(contractId: string) {
    const row = this.rows.find((r) => r.contract.id === contractId);
    if (row) row.eventClaimed = false;
  }
  latestVersion(userId: string, cycleId: string) {
    return this.latest(userId, cycleId)?.contract.version ?? 0;
  }
  save(userId: string, contract: CommitmentContract) {
    this.rows.push({ userId, contract: Object.freeze(contract), eventPublishedAt: null, eventClaimed: false });
  }
  markEventPublished(contractId: string, at: string) {
    const row = this.rows.find((r) => r.contract.id === contractId);
    if (row) row.eventPublishedAt = at;
  }
  private latest(userId: string, cycleId: string) {
    return this.rows
      .filter((r) => r.userId === userId && r.contract.cycleId === cycleId)
      .sort((a, b) => b.contract.version - a.contract.version)[0];
  }
}

/** M1 stub: real content (budget rules, windows, thresholds) is filled in by later issues. */
export function stubContractSummary(): ContractSummary {
  return {
    budgetRules: {},
    supervisionWindows: [],
    thresholds: [],
    weeklyCapVnd: 0,
    commitRoutines: [],
    penaltySavingsUnlock: { kind: "goal", value: "stub" },
  };
}

export type ContractServiceDeps = {
  store: ContractStore;
  publish?: (event: EventEnvelope) => void | Promise<void>;
  now: () => Date;
  newId?: () => string;
  buildSummary?: (userId: string, cycleId: string) => ContractSummary;
  onPublishError?: (err: unknown) => void;
};

export function createContractService(deps: ContractServiceDeps) {
  const newId = deps.newId ?? randomUUID;
  const buildSummary = deps.buildSummary ?? stubContractSummary;

  async function emit(userId: string, contract: CommitmentContract): Promise<void> {
    const payload: EventPayload<"contract.signed"> = {
      contractId: contract.id,
      cycleId: contract.cycleId,
      version: contract.version,
    };
    try {
      await deps.publish?.({
        id: newId(),
        type: "contract.signed",
        userId,
        occurredAt: deps.now().toISOString(),
        schemaVersion: EVENT_SCHEMA_VERSION,
        payload,
      } as EventEnvelope);
      deps.store.markEventPublished(contract.id, deps.now().toISOString());
    } catch (err) {
      deps.store.releaseEventClaim(contract.id);
      deps.onPublishError?.(err);
    }
  }

  return {
    /** Signs the cycle's contract once; a repeat call returns it and emits nothing new. */
    async sign(userId: string, cycleId: string) {
      const existing = deps.store.findSigned(userId, cycleId);
      if (existing) {
        const owed = deps.store.claimOwedEvent(userId, cycleId);
        if (owed) await emit(userId, owed);
        return { contract: existing, alreadySigned: true };
      }
      const contract: CommitmentContract = {
        id: newId(),
        cycleId,
        version: deps.store.latestVersion(userId, cycleId) + 1,
        signedAt: deps.now().toISOString(),
        summary: buildSummary(userId, cycleId),
      };
      deps.store.save(userId, contract);
      const claimed = deps.store.claimOwedEvent(userId, cycleId);
      if (claimed) await emit(userId, claimed);
      return { contract, alreadySigned: false };
    },
  };
}
