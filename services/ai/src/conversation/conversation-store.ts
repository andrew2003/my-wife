import { randomUUID } from "node:crypto";

export interface ConversationTurn {
  id: string;
  userId: string;
  role: "user" | "assistant";
  text: string;
  at: Date;
}

/** Port for conversation turns; the Drizzle table comes with the persistence issue. */
export interface ConversationStore {
  append(input: Omit<ConversationTurn, "id">): Promise<ConversationTurn>;
  /** Turns not yet compacted into a summary, oldest first. */
  listActive(userId: string): Promise<ConversationTurn[]>;
  /** Users that have at least one active turn. */
  usersWithTurns(): Promise<string[]>;
  /** Removes the given turns, once their summary is stored. */
  compact(userId: string, turnIds: readonly string[]): Promise<void>;
}

export class InMemoryConversationStore implements ConversationStore {
  private turns: ConversationTurn[] = [];

  async append(input: Omit<ConversationTurn, "id">): Promise<ConversationTurn> {
    const turn = { ...input, id: randomUUID() };
    this.turns.push(turn);
    return turn;
  }

  async listActive(userId: string): Promise<ConversationTurn[]> {
    return this.turns.filter((t) => t.userId === userId);
  }

  async usersWithTurns(): Promise<string[]> {
    return [...new Set(this.turns.map((t) => t.userId))];
  }

  async compact(userId: string, turnIds: readonly string[]): Promise<void> {
    const ids = new Set(turnIds);
    this.turns = this.turns.filter((t) => t.userId !== userId || !ids.has(t.id));
  }
}
