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
  getByRole(userId: string, role: ModelRole): Promise<StoredLlmKey | null>;
  delete(userId: string, keyId: string): Promise<boolean>;
}

export class InMemoryLlmKeyStore implements LlmKeyStore {
  private rows: StoredLlmKey[] = [];

  async put(key: StoredLlmKey): Promise<void> {
    this.rows = this.rows.filter((r) => !(r.userId === key.userId && r.role === key.role));
    this.rows.push(key);
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
    return this.rows.length < before;
  }
  /** Raw rows, for tests that inspect what is stored at rest. */
  dump(): StoredLlmKey[] {
    return [...this.rows];
  }
}
