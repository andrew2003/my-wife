import { generateKeyPairSync } from "node:crypto";
import { dkimSign } from "mailauth";

/** Synthetic DKIM key and DNS; no real bank data is committed. */
const good = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = (k: typeof good.privateKey) => k.export({ type: "pkcs8", format: "pem" }).toString();
const publicB64 = good.publicKey.export({ type: "spki", format: "der" }).toString("base64");

export const BANK_DOMAIN = "bank.test";
export const BANK_ADDRESS = "alerts@bank.test";
export const SELECTOR = "s1";
export const SUBJECT = "Balance change notice 26/11/2026";

/** Resolver that serves only the test bank key. */
export const testResolver = async (name: string, rr: string): Promise<string[][]> => {
  if (rr === "TXT" && name === `${SELECTOR}._domainkey.${BANK_DOMAIN}`) {
    return [[`v=DKIM1; k=rsa; p=${publicB64}`]];
  }
  const err = new Error(`ENOTFOUND ${name}`) as Error & { code: string };
  err.code = "ENOTFOUND";
  throw err;
};

export type MailOptions = {
  from?: string;
  subject?: string;
  messageId?: string;
  body?: string;
  sign?: "valid" | "none" | "forged";
};

export const DEBIT_BODY = [
  "Transaction notice",
  "Account: ****1234",
  "Debit: 150,000 VND",
  "Time: 26/11/2026 10:15:30",
  "Ref: FT26330ABC123",
  "Details: MW-C1W1-FOOD-01",
  "Balance: 2,350,000 VND",
].join("\r\n");

export async function buildMail(opts: MailOptions = {}): Promise<Buffer> {
  const from = opts.from ?? BANK_ADDRESS;
  const message =
    `From: Bank <${from}>\r\nTo: u-tok123@in.example.test\r\n` +
    `Subject: ${opts.subject ?? SUBJECT}\r\n` +
    `Message-ID: <${opts.messageId ?? "m1@bank.test"}>\r\nDate: Thu, 26 Nov 2026 03:15:35 +0000\r\n` +
    `Content-Type: text/plain; charset=utf-8\r\n\r\n${opts.body ?? DEBIT_BODY}\r\n`;
  const mode = opts.sign ?? "valid";
  if (mode === "none") return Buffer.from(message);
  const { signatures } = await dkimSign(message, {
    signatureData: [
      {
        signingDomain: BANK_DOMAIN,
        selector: SELECTOR,
        privateKey: pem(mode === "forged" ? other.privateKey : good.privateKey),
      },
    ],
  });
  return Buffer.from(signatures + message);
}
