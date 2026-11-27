import { createPrivateKey, sign } from "node:crypto";

export interface VapidConfig {
  /** `mailto:` or https contact URL sent to push services. */
  subject: string;
  /** Uncompressed P-256 public key, base64url (65 bytes). */
  publicKey: string;
  /** P-256 private scalar, base64url (32 bytes). Read from the environment, never logged. */
  privateKey: string;
}

const b64 = (value: string | Buffer) => Buffer.from(value).toString("base64url");

/** Builds the `Authorization` header value of RFC 8292 for one push service origin. */
export function vapidAuthorization(
  vapid: VapidConfig,
  audience: string,
  now: Date,
  ttlSeconds: number,
): string {
  const pub = Buffer.from(vapid.publicKey, "base64url");
  const key = createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: vapid.privateKey,
      x: pub.subarray(1, 33).toString("base64url"),
      y: pub.subarray(33, 65).toString("base64url"),
    },
    format: "jwk",
  });
  const head = b64(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64(
    JSON.stringify({
      aud: audience,
      exp: Math.floor(now.getTime() / 1000) + ttlSeconds,
      sub: vapid.subject,
    }),
  );
  const signature = sign("sha256", Buffer.from(`${head}.${claims}`), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  return `vapid t=${head}.${claims}.${b64(signature)}, k=${vapid.publicKey}`;
}
