import type { ModelRole } from "@my-wife/contracts";
import type { LlmProvider } from "./key-validator";
import type { SealedSecret } from "./secrets-crypto";

/** One stored key. The secret exists only as `sealed`; there is no plaintext field. */
export interface StoredLlmKey {
  keyId: string;
  userId: string;
  provider: LlmProvider;
  model: string;
  role: ModelRole;
  valid: boolean;
  sealed: SealedSecret;
}

export interface LlmKeyStore {
  /** Saves a key; an existing key of the same user and role is replaced. */
  put(key: StoredLlmKey): Promise<void>;
  list(userId: string): Promise<StoredLlmKey[]>;
  /**
   * Keyset page ordered by key id ascending. `after` is the `next` of the previous page; `next` is
   * null on the last page. A persistent implementation must back this with an index on
   * (user_id, key_id).
   */
  listPage(
    userId: string,
    limit: number,
    after: string | null,
  ): Promise<{ items: StoredLlmKey[]; next: string | null }>;
  getByRole(userId: string, role: ModelRole): Promise<StoredLlmKey | null>;
  delete(userId: string, keyId: string): Promise<boolean>;
}

export class InMemoryLlmKeyStore implements LlmKeyStore {
  private rows: StoredLlmKey[] = [];
  /** Per-user rows kept sorted by key id, maintained on insert (the in-memory index). */
  private readonly byKeyId = new Map<string, StoredLlmKey[]>();

  private reindex(): void {
    this.byKeyId.clear();
    for (const row of this.rows) this.indexRow(row);
  }
  private indexRow(row: StoredLlmKey): void {
    const index = this.byKeyId.get(row.userId) ?? [];
    let lo = 0;
    let hi = index.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (index[mid]!.keyId < row.keyId) lo = mid + 1;
      else hi = mid;
    }
    index.splice(lo, 0, row);
    this.byKeyId.set(row.userId, index);
  }

  async put(key: StoredLlmKey): Promise<void> {
    this.rows = this.rows.filter((r) => !(r.userId === key.userId && r.role === key.role));
    this.rows.push(key);
    this.reindex();
  }
  /** Adds a row without the one-key-per-role replacement, for tests with many keys. */
  seed(key: StoredLlmKey): void {
    this.rows.push(key);
    this.indexRow(key);
  }
  async listPage(userId: string, limit: number, after: string | null) {
    const index = this.byKeyId.get(userId) ?? [];
    let lo = 0;
    if (after !== null) {
      let hi = index.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (index[mid]!.keyId <= after) lo = mid + 1;
        else hi = mid;
      }
    }
    const items = index.slice(lo, lo + limit);
    const last = items[items.length - 1];
    return { items, next: last !== undefined && lo + limit < index.length ? last.keyId : null };
  }
  async list(userId: string): Promise<StoredLlmKey[]> {
    return this.rows.filter((r) => r.userId === userId);
  }
  async getByRole(userId: string, role: ModelRole): Promise<StoredLlmKey | null> {
    return this.rows.find((r) => r.userId === userId && r.role === role) ?? null;
  }
  async delete(userId: string, keyId: string): Promise<boolean> {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !(r.userId === userId && r.keyId === keyId));
    this.reindex();
    return this.rows.length < before;
  }
  /** Raw rows, for tests that inspect what is stored at rest. */
  dump(): StoredLlmKey[] {
    return [...this.rows];
  }
}
