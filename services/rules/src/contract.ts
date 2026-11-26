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
};

export interface ContractStore {
  findSigned(userId: string, cycleId: string): CommitmentContract | undefined;
  findOwedEvent(userId: string, cycleId: string): CommitmentContract | undefined;
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
  findOwedEvent(userId: string, cycleId: string) {
    const row = this.latest(userId, cycleId);
    return row && row.eventPublishedAt === null ? row.contract : undefined;
  }
  latestVersion(userId: string, cycleId: string) {
    return this.latest(userId, cycleId)?.contract.version ?? 0;
  }
  save(userId: string, contract: CommitmentContract) {
    this.rows.push({ userId, contract: Object.freeze(contract), eventPublishedAt: null });
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
      deps.onPublishError?.(err);
    }
  }

  return {
    /** Signs the cycle's contract once; a repeat call returns it and emits nothing new. */
    async sign(userId: string, cycleId: string) {
      const existing = deps.store.findSigned(userId, cycleId);
      if (existing) {
        const owed = deps.store.findOwedEvent(userId, cycleId);
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
      await emit(userId, contract);
      return { contract, alreadySigned: false };
    },
  };
}
