import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export type Keyring = { currentKeyId: string; keys: Map<string, Buffer> };

/** A sealed secret: which key encrypted it and `base64(nonce | tag | ciphertext)`. */
export type SealedSecret = { keyId: string; payload: string };

function decodeKey(id: string, base64: string): Buffer {
  const key = Buffer.from(base64, "base64");
  if (key.length !== KEY_BYTES) throw new Error(`secrets key ${id} must be ${KEY_BYTES} bytes`);
  return key;
}

/**
 * Builds the keyring from configuration. `previousKeys` is `id:base64,id:base64` and only
 * exists so rows written before a rotation stay readable (each row stores its `key_id`).
 */
export function parseKeyring(input: {
  currentKeyId: string;
  masterKey: string;
  previousKeys?: string;
}): Keyring {
  const keys = new Map<string, Buffer>();
  for (const entry of (input.previousKeys ?? "").split(",").filter(Boolean)) {
    const at = entry.indexOf(":");
    if (at <= 0) throw new Error("secrets previous keys must look like id:base64,id:base64");
    const id = entry.slice(0, at);
    keys.set(id, decodeKey(id, entry.slice(at + 1)));
  }
  keys.set(input.currentKeyId, decodeKey(input.currentKeyId, input.masterKey));
  return { currentKeyId: input.currentKeyId, keys };
}

/** `binding` (for example `userId:kind`) is authenticated, so a row cannot be moved to another owner. */
export function encryptSecret(plain: string, ring: Keyring, binding: string): SealedSecret {
  const key = ring.keys.get(ring.currentKeyId);
  if (!key) throw new Error("current secrets key missing");
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(binding));
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const payload = Buffer.concat([nonce, cipher.getAuthTag(), body]).toString("base64");
  return { keyId: ring.currentKeyId, payload };
}

export function decryptSecret(sealed: SealedSecret, ring: Keyring, binding: string): string {
  const key = ring.keys.get(sealed.keyId);
  if (!key) throw new Error(`unknown secrets key ${sealed.keyId}`);
  const raw = Buffer.from(sealed.payload, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, NONCE_BYTES));
  decipher.setAAD(Buffer.from(binding));
  decipher.setAuthTag(raw.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES));
  return Buffer.concat([
    decipher.update(raw.subarray(NONCE_BYTES + TAG_BYTES)),
    decipher.final(),
  ]).toString("utf8");
}
