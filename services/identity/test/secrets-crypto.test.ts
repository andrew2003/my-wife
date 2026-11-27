import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, parseKeyring } from "../src/secrets-crypto";

const K1 = Buffer.alloc(32, 1).toString("base64");
const K2 = Buffer.alloc(32, 2).toString("base64");

describe("secret encryption (AES-256-GCM)", () => {
  const ring = parseKeyring({ currentKeyId: "k1", masterKey: K1 });

  it("round-trips and never stores the plaintext", () => {
    const sealed = encryptSecret("sk-live-abc123", ring, "u1:llm_key");
    expect(sealed.keyId).toBe("k1");
    expect(sealed.payload).not.toContain("sk-live-abc123");
    expect(Buffer.from(sealed.payload, "base64").toString("latin1")).not.toContain("abc123");
    expect(decryptSecret(sealed, ring, "u1:llm_key")).toBe("sk-live-abc123");
  });

  it("uses a fresh nonce each time", () => {
    expect(encryptSecret("x", ring, "a").payload).not.toBe(encryptSecret("x", ring, "a").payload);
  });

  it("rejects tampering and a different binding (another user or kind)", () => {
    const sealed = encryptSecret("x", ring, "u1:llm_key");
    expect(() => decryptSecret(sealed, ring, "u2:llm_key")).toThrow();
    const raw = Buffer.from(sealed.payload, "base64");
    raw.writeUInt8(raw.readUInt8(raw.length - 1) ^ 1, raw.length - 1);
    expect(() =>
      decryptSecret({ ...sealed, payload: raw.toString("base64") }, ring, "u1:llm_key"),
    ).toThrow();
  });

  it("decrypts old rows after rotation using the row's key id", () => {
    const sealed = encryptSecret("x", ring, "b");
    const rotated = parseKeyring({
      currentKeyId: "k2",
      masterKey: K2,
      previousKeys: `k1:${K1}`,
    });
    expect(decryptSecret(sealed, rotated, "b")).toBe("x");
    expect(encryptSecret("y", rotated, "b").keyId).toBe("k2");
  });

  it("rejects a malformed previous-keys entry with a clear message", () => {
    expect(() => parseKeyring({ currentKeyId: "k2", masterKey: K2, previousKeys: K1 })).toThrow(
      /id:base64/,
    );
  });

  it("rejects a master key that is not 32 bytes", () => {
    expect(() => parseKeyring({ currentKeyId: "k1", masterKey: "c2hvcnQ=" })).toThrow();
  });
});
