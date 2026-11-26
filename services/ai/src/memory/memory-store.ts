import { randomUUID } from "node:crypto";
/**
 * `model_proposal` is service-local: an unconfirmed LLM proposal. It is never announced and never
 * placed in a prompt until confirmed (follow-up #240). The other values match the contracts enum.
 */
type MemorySource = "user_answer" | "tool_call" | "user_edit" | "model_proposal";

export interface MemoryRecord {
  id: string;
  userId: string;
  fact: string;
  source: MemorySource;
  createdAt: Date;
}

/** Port for memory storage; the Drizzle table comes with the persistence issue. */
export interface MemoryStore {
  add(input: Omit<MemoryRecord, "id"> & { id?: string }): Promise<MemoryRecord>;
  /** All memories of one user, newest first. */
  list(userId: string): Promise<MemoryRecord[]>;
}

export class InMemoryMemoryStore implements MemoryStore {
  private readonly rows: MemoryRecord[] = [];

  async add(input: Omit<MemoryRecord, "id"> & { id?: string }): Promise<MemoryRecord> {
    const row: MemoryRecord = { ...input, id: input.id ?? randomUUID() };
    this.rows.push(row);
    return row;
  }

  async list(userId: string): Promise<MemoryRecord[]> {
    return this.rows
      .filter((r) => r.userId === userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
}
