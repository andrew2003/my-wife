import { randomUUID } from "node:crypto";
import type { LlmKeyView, ModelRole } from "@my-wife/contracts";
import type { LlmProvider } from "./key-validator";
import type { KeyValidator } from "./key-validator";
import type { LlmKeyStore, StoredLlmKey } from "./key-store";
import { decryptSecret, encryptSecret, type Keyring } from "./secrets-crypto";

export class SecretsUnavailableError extends Error {
  constructor() {
    super("secrets_unavailable");
    this.name = "SecretsUnavailableError";
  }
}

export interface ResolvedKey {
  provider: LlmProvider;
  model: string;
  apiKey: string;
}

export interface LlmKeyServiceDeps {
  store: LlmKeyStore;
  validator: KeyValidator;
  /** Absent when `SECRETS_MASTER_KEY` is not configured; saving and resolving then fail. */
  ring: Keyring | null;
  publish: (event: {
    name: "llm_key.saved" | "llm_key.invalid";
    payload: { role: ModelRole; keyId: string };
  }) => Promise<void>;
}

const view = (k: StoredLlmKey): LlmKeyView => ({
  provider: k.provider,
  model: k.model,
  keyId: k.keyId,
  valid: k.valid,
  role: k.role,
});

/** Stores user keys encrypted. Plaintext leaves only through `resolve`, inside this service. */
export class LlmKeyService {
  constructor(private readonly deps: LlmKeyServiceDeps) {}

  async save(
    userId: string,
    input: { provider: LlmProvider; model: string; role: ModelRole; apiKey: string },
  ): Promise<LlmKeyView> {
    const ring = this.ring();
    let valid: boolean;
    try {
      valid = await this.deps.validator.validate({
        provider: input.provider,
        model: input.model,
        apiKey: input.apiKey,
      });
    } catch {
      // The error may quote the key; it is dropped and the key counts as invalid.
      valid = false;
    }
    const keyId = `key_${randomUUID()}`;
    const stored: StoredLlmKey = {
      keyId,
      userId,
      provider: input.provider,
      model: input.model,
      role: input.role,
      valid,
      sealed: encryptSecret(input.apiKey, ring, `${userId}:llm_key:${input.role}`),
    };
    await this.deps.store.put(stored);
    await this.deps.publish({
      name: valid ? "llm_key.saved" : "llm_key.invalid",
      payload: { role: input.role, keyId },
    });
    return view(stored);
  }

  private ring(): Keyring {
    if (!this.deps.ring) throw new SecretsUnavailableError();
    return this.deps.ring;
  }

  async list(userId: string): Promise<LlmKeyView[]> {
    return (await this.deps.store.list(userId)).map(view);
  }

  remove(userId: string, keyId: string): Promise<boolean> {
    return this.deps.store.delete(userId, keyId);
  }

  /** Internal only: the decrypted key for a model call. Never route this to a response or a log. */
  async resolve(userId: string, role: ModelRole): Promise<ResolvedKey | null> {
    const row = await this.deps.store.getByRole(userId, role);
    if (!row || !row.valid) return null;
    const apiKey = decryptSecret(row.sealed, this.ring(), `${userId}:llm_key:${role}`);
    return { provider: row.provider, model: row.model, apiKey };
  }
}
