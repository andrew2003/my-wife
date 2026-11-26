import { createHash } from "node:crypto";

/** Normalized facts read from one email. Never carries a category or type: `budget` decides. */
export type ParsedFields = {
  bankTransactionRef: string;
  bankAccountHint: string;
  direction: "in" | "out";
  amountVnd: number;
  currency: string;
  counterparty: string | null;
  memo: string;
  occurredAt: string;
  balanceAfterVnd?: number;
};

/** The exact strings the fields were read from; each must appear verbatim in the email. */
export type RawEvidence = { amount: string; ref: string; time: string };

export type ParseResult =
  { ok: true; raw: RawEvidence; fields: ParsedFields } | { ok: false; reason: string };

/** A parser is data plus a pure function: no network, no clock, no LLM. */
export type TemplateParser = {
  id: string;
  version: number;
  parse: (body: string) => ParseResult;
};

export type RegisteredTemplate = TemplateParser & { senderKey: string; fingerprint: string };

const AMOUNT_RE = /^(?:\d{1,3}(?:[.,]\d{3})+|\d+)$/;

/** Integer VND from a thousands-separated amount. Returns null for anything ambiguous. */
export function parseAmountVnd(raw: string): number | null {
  const s = raw.trim();
  if (!AMOUNT_RE.test(s)) return null;
  const n = Number(s.replace(/[.,]/g, ""));
  return Number.isSafeInteger(n) ? n : null;
}

const LABEL_RE = /^\s*([A-Za-z][A-Za-z ]{0,40}):/;

function labelsOf(body: string): string[] {
  return body
    .split(/\r?\n/)
    .map((l) => LABEL_RE.exec(l)?.[1]?.trim().toLowerCase())
    .filter((l): l is string => Boolean(l));
}

/** hash(sender + subject shape + body structure). Values never enter the hash. */
export function fingerprintTemplate(input: {
  sender: string;
  subject: string;
  body: string;
}): string {
  const shape = input.subject.toLowerCase().replace(/\d/g, "0").replace(/\s+/g, " ").trim();
  const material = [input.sender.toLowerCase(), shape, labelsOf(input.body).join(",")].join("\n");
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

/** Whitespace-normalized containment check; the evidence must be in the email as written. */
export function appearsVerbatim(evidence: string, body: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  return evidence.length > 0 && norm(body).includes(norm(evidence));
}

export function verifyEvidence(raw: RawEvidence, body: string): boolean {
  return [raw.amount, raw.ref, raw.time].every((e) => appearsVerbatim(e, body));
}

const TIME_RE = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/;

/** Local bank time to a UTC ISO string; null for impossible dates. */
function toUtcIso(raw: string, offsetMinutes: number): string | null {
  const m = TIME_RE.exec(raw);
  if (!m) return null;
  const [d, mo, y, h, mi, s] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(ms);
  if (back.getUTCDate() !== d || back.getUTCMonth() !== mo - 1 || h > 23 || mi > 59 || s > 59)
    return null;
  return new Date(ms - offsetMinutes * 60_000).toISOString();
}

function valuesOf(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of body.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z][A-Za-z ]{0,40}):(.*)$/.exec(line);
    const key = m?.[1]?.trim().toLowerCase();
    if (key && !out.has(key)) out.set(key, (m?.[2] ?? "").trim());
  }
  return out;
}

const fail = (reason: string): ParseResult => ({ ok: false, reason });

/** Basic "Label: value" bank layout; Vietnam local time (UTC+7). */
export const BASIC_BANK_TEMPLATE: TemplateParser = {
  id: "basic-bank",
  version: 1,
  parse(body) {
    const v = valuesOf(body);
    const debit = v.get("debit");
    const credit = v.get("credit");
    if ((debit ? 1 : 0) + (credit ? 1 : 0) !== 1) return fail("direction");
    const amountText = (debit ?? credit ?? "").replace(/\s*VND$/, "");
    const amountVnd = parseAmountVnd(amountText);
    if (amountVnd === null) return fail("amount");

    const ref = v.get("ref") ?? "";
    if (!/^[A-Za-z0-9]{4,40}$/.test(ref)) return fail("ref");

    const timeText = v.get("time") ?? "";
    const occurredAt = toUtcIso(timeText, 420);
    if (!occurredAt) return fail("time");

    const hint = /(\d{3,})$/.exec(v.get("account") ?? "")?.[1];
    if (!hint) return fail("account");

    const fields: ParsedFields = {
      bankTransactionRef: ref,
      bankAccountHint: hint,
      direction: debit ? "out" : "in",
      amountVnd,
      currency: "VND",
      counterparty: null,
      memo: v.get("details") ?? "",
      occurredAt,
    };
    const balanceText = v.get("balance");
    if (balanceText) {
      const balance = parseAmountVnd(balanceText.replace(/\s*VND$/, ""));
      if (balance === null) return fail("balance");
      fields.balanceAfterVnd = balance;
    }
    return { ok: true, raw: { amount: amountText, ref, time: timeText }, fields };
  },
};
