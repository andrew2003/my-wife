import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

/** AES-256-GCM sealing for push endpoints and keys; the user id is authenticated data. */
export function seal(key: Buffer, plaintext: string, aad: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString("base64");
}

export function open(key: Buffer, sealed: string, aad: string): string {
  const raw = Buffer.from(sealed, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

/** Keyed hash used to find a stored subscription without keeping its endpoint in clear. */
export function blindIndex(key: Buffer, value: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}
