import { randomUUID } from "node:crypto";

export type ToolOutcome = "executed" | "proposed" | "rejected" | "failed";

export interface ToolAuditEntry {
  id: string;
  userId: string;
  /** Raw tool name as the model sent it; may be unknown when the call was rejected. */
  tool: string;
  outcome: ToolOutcome;
  /** Validated arguments only; absent for rejected calls so untrusted text is not stored. */
  args?: unknown;
  at: Date;
}

/** Port for the `audit_log` table; the Drizzle table comes with the persistence issue. */
export interface AuditLog {
  append(entry: Omit<ToolAuditEntry, "id">): Promise<ToolAuditEntry>;
  list(userId: string): Promise<ToolAuditEntry[]>;
}

export class InMemoryAuditLog implements AuditLog {
  private readonly rows: ToolAuditEntry[] = [];

  async append(entry: Omit<ToolAuditEntry, "id">): Promise<ToolAuditEntry> {
    const row = { ...entry, id: randomUUID() };
    this.rows.push(row);
    return row;
  }

  async list(userId: string): Promise<ToolAuditEntry[]> {
    return this.rows.filter((r) => r.userId === userId);
  }
}
