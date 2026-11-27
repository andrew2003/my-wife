import { aiEvents } from "@my-wife/contracts";
import type { MemoryStore } from "./memory-store";
import { extractExplicitFact, rememberTriggers } from "./triggers";

export interface MemoryServiceOptions {
  store: MemoryStore;
  publish: (event: {
    name: "memory.created" | "memory.deleted";
    payload: unknown;
  }) => Promise<void>;
  /** Max memories placed in the context for this user (`ai.memory_retrieval_top_k`). */
  topK: (userId: string) => Promise<number>;
  /** Service guards on a proposed fact; code decides, the LLM only proposes. */
  maxFactLength: number;
  maxPerTurn: number;
}

/** Service limits with no setting key yet; defaults are named here, never inside the logic. */
export const DEFAULT_MEMORY_LIMITS = {
  maxFactLength: 300,
  maxPerTurn: 3,
  maxSummaryLength: 1500,
} as const;

/** Longest accepted conversation summary (`AI_SUMMARY_MAX_LENGTH`, no registry key yet). */
export function loadSummaryMaxLength(env: Record<string, string | undefined> = process.env) {
  const n = Number(env.AI_SUMMARY_MAX_LENGTH);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MEMORY_LIMITS.maxSummaryLength;
}

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

  /** Confirmed memories for the next context, newest first, at most top-k. */
  async recall(userId: string): Promise<string[]> {
    const rows = (await this.options.store.list(userId)).filter(
      (r) => r.source !== "model_proposal" && r.source !== "summary",
    );
    return rows.slice(0, await this.options.topK(userId)).map((r) => r.fact);
  }

  /**
   * Conversation summaries, newest first, at most top-k. They are model text, so they have no
   * fact-level authority: the prompt lists them in a separate informational block.
   */
  async recallSummaries(userId: string): Promise<string[]> {
    const rows = (await this.options.store.list(userId)).filter((r) => r.source === "summary");
    return rows.slice(0, await this.options.topK(userId)).map((r) => r.fact);
  }

  /** Deletes one of the user's memories and announces it; false when there is none. */
  async delete(userId: string, memoryId: string): Promise<boolean> {
    if (!(await this.options.store.remove(userId, memoryId))) return false;
    await this.options.publish({
      name: "memory.deleted",
      payload: aiEvents["memory.deleted"].parse({ memoryId }),
    });
    return true;
  }

  /**
   * When the turn ends: an explicit "remember ..." request of the user is stored as `user_answer`
   * and announced; model proposals are stored as pending `model_proposal` rows, silently.
   * Blank, oversized and duplicate facts are dropped.
   */
  async endTurn(
    userId: string,
    userText: string,
    proposals: readonly string[],
    now: Date,
  ): Promise<void> {
    const rows = await this.options.store.list(userId);
    const known = new Set(rows.map((r) => r.fact.toLowerCase()));
    // A pending proposal never blocks the user's own explicit request.
    const confirmed = new Set(
      rows.filter((r) => r.source !== "model_proposal").map((r) => r.fact.toLowerCase()),
    );
    const explicit = extractExplicitFact(userText, rememberTriggers());
    if (explicit !== null && this.accept(explicit, confirmed)) {
      known.add(explicit.toLowerCase());
      const row = await this.options.store.add({
        userId,
        fact: explicit,
        source: "user_answer",
        createdAt: now,
      });
      await this.options.publish({
        name: "memory.created",
        payload: aiEvents["memory.created"].parse({ memoryId: row.id }),
      });
    }
    let pending = 0;
    for (const proposal of proposals) {
      if (pending >= this.options.maxPerTurn) break;
      const fact = proposal.trim();
      if (!this.accept(fact, known)) continue;
      await this.options.store.add({ userId, fact, source: "model_proposal", createdAt: now });
      pending += 1;
    }
  }

  private accept(fact: string, known: Set<string>): boolean {
    if (fact.length === 0 || fact.length > this.options.maxFactLength) return false;
    if (known.has(fact.toLowerCase())) return false;
    known.add(fact.toLowerCase());
    return true;
  }
}
