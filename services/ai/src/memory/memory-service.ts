import { aiEvents } from "@my-wife/contracts";
import type { MemoryStore } from "./memory-store";

export interface MemoryServiceOptions {
  store: MemoryStore;
  publish: (event: { name: "memory.created"; payload: unknown }) => Promise<void>;
  /** Max memories placed in the context for this user (`ai.memory_retrieval_top_k`). */
  topK: (userId: string) => Promise<number>;
  /** Service guards on a proposed fact; code decides, the LLM only proposes. */
  maxFactLength: number;
  maxPerTurn: number;
}

/** Service limits with no setting key yet; defaults are named here, never inside the logic. */
export const DEFAULT_MEMORY_LIMITS = { maxFactLength: 300, maxPerTurn: 3 } as const;

/** Reads the limits from the environment, falling back to the named defaults. */
export function loadMemoryLimits(env: Record<string, string | undefined> = process.env) {
  const read = (value: string | undefined, fallback: number) => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : fallback;
  };
  return {
    maxFactLength: read(env.AI_MEMORY_MAX_FACT_LENGTH, DEFAULT_MEMORY_LIMITS.maxFactLength),
    maxPerTurn: read(env.AI_MEMORY_MAX_PER_TURN, DEFAULT_MEMORY_LIMITS.maxPerTurn),
  };
}

export class MemoryService {
  constructor(private readonly options: MemoryServiceOptions) {}

  /** The memories for the next context, newest first, at most top-k. */
  async recall(userId: string): Promise<string[]> {
    const rows = await this.options.store.list(userId);
    return rows.slice(0, await this.options.topK(userId)).map((r) => r.fact);
  }

  /**
   * Validates proposals and writes the accepted ones, then announces each one.
   * Blank, oversized and duplicate facts are dropped silently.
   */
  async remember(userId: string, proposals: readonly string[], now: Date): Promise<void> {
    const maxLength = this.options.maxFactLength;
    const maxPerTurn = this.options.maxPerTurn;
    const known = new Set((await this.options.store.list(userId)).map((r) => r.fact.toLowerCase()));
    let accepted = 0;
    for (const proposal of proposals) {
      if (accepted >= maxPerTurn) break;
      const fact = proposal.trim();
      if (fact.length === 0 || fact.length > maxLength) continue;
      if (known.has(fact.toLowerCase())) continue;
      known.add(fact.toLowerCase());
      const row = await this.options.store.add({
        userId,
        fact,
        source: "tool_call",
        createdAt: now,
      });
      accepted += 1;
      await this.options.publish({
        name: "memory.created",
        payload: aiEvents["memory.created"].parse({ memoryId: row.id }),
      });
    }
  }
}
