import { simpleParser } from "mailparser";
import type { EventEnvelope, ReceiptState } from "@my-wife/contracts";
import { domainAligned, type DkimVerifier } from "./dkim";
import type { IngestStore, ReceiptRecord } from "./store";
import { fingerprintTemplate, verifyEvidence, type RegisteredTemplate } from "./templates";

export type SenderMapEntry = { senderKey: string; senderAddress: string; dkimDomain: string };

export type PipelineDeps = {
  store: IngestStore;
  verifyDkim: DkimVerifier;
  /** Resolves the token of `u-<token>@in.<domain>`; null when no such address exists. */
  users: { resolve(token: string): Promise<{ userId: string; emailConsent: boolean } | null> };
  senderMap: SenderMapEntry[];
  templates: RegisteredTemplate[];
  publish: (event: EventEnvelope) => Promise<void>;
  newId: () => string;
  /** `ingest.max_email_bytes` (admin setting). */
  settings: { maxEmailBytes: number };
};

export type InboundMail = { toAddress: string; raw: Buffer };

export type InboundOutcome =
  { state: "unknown_address" } | { state: ReceiptState; receiptId: string; reason?: string };

function tokenOf(address: string): string | null {
  const m = /^u-([A-Za-z0-9_-]+)@/.exec(address.trim());
  return m?.[1] ?? null;
}

const stripTags = (html: string) => html.replace(/<[^>]*>/g, "\n");

/** Email content is untrusted data: it is only ever read for facts, never obeyed. */
export async function processInbound(
  mail: InboundMail,
  deps: PipelineDeps,
  now: Date,
): Promise<InboundOutcome> {
  const token = tokenOf(mail.toAddress);
  const user = token ? await deps.users.resolve(token) : null;
  if (!user) return { state: "unknown_address" };

  const receiptId = deps.newId();
  const emit = (type: EventEnvelope["type"], payload: unknown) =>
    deps.publish({
      id: deps.newId(),
      type,
      occurredAt: now.toISOString(),
      userId: user.userId,
      schemaVersion: 1,
      payload,
    } as EventEnvelope);

  // Rejected before anything is read or stored.
  const early = !user.emailConsent
    ? "no_consent"
    : mail.raw.length > deps.settings.maxEmailBytes
      ? "too_large"
      : null;
  if (early) {
    await emit("receipt.rejected", { receiptId, reason: early, sender: null });
    return { state: "rejected", receiptId, reason: early };
  }

  const parsed = await simpleParser(mail.raw);
  const from = parsed.from?.value[0]?.address?.toLowerCase() ?? null;
  const subject = parsed.subject ?? "";
  const body = parsed.text ?? (typeof parsed.html === "string" ? stripTags(parsed.html) : "");
  const messageId = parsed.messageId ?? null;

  const base: ReceiptRecord = {
    id: receiptId,
    userId: user.userId,
    state: "received",
    messageId,
    sender: from,
    sizeBytes: mail.raw.length,
    receivedAt: now.toISOString(),
    dkimResult: "none",
  };
  const finish = async (record: ReceiptRecord): Promise<InboundOutcome> => {
    await deps.store.save(record);
    return { state: record.state, receiptId, reason: record.rejectReason };
  };

  // 1. Authenticate: a valid DKIM signature of the mapped bank domain is required.
  const entry = from
    ? deps.senderMap.find((e) => e.senderAddress.toLowerCase() === from)
    : undefined;
  const verdict = await deps.verifyDkim(mail.raw);
  const authentic =
    from !== null &&
    verdict.result === "pass" &&
    verdict.domain !== null &&
    domainAligned(verdict.domain, from, entry?.dkimDomain);
  if (!authentic) {
    await emit("receipt.rejected", { receiptId, reason: "dkim_invalid", sender: from });
    return finish({
      ...base,
      state: "rejected",
      dkimResult: verdict.result,
      rejectReason: "dkim_invalid",
    });
  }
  const authed = { ...base, dkimResult: "pass" as const };

  // 2. Deduplicate by Message-ID.
  if (messageId && (await deps.store.findByMessageId(user.userId, messageId))) {
    return finish({ ...authed, state: "duplicate" });
  }

  // 3. Fingerprint the template; an unmapped sender or unknown layout is not parsed.
  const fingerprint = fingerprintTemplate({ sender: from, subject, body });
  const template = entry
    ? deps.templates.find((t) => t.senderKey === entry.senderKey && t.fingerprint === fingerprint)
    : undefined;
  if (!entry || !template) {
    await emit("receipt.unknown", {
      receiptId,
      templateFingerprint: fingerprint,
      sender: entry?.senderKey ?? from,
    });
    return finish({ ...authed, state: "needs_confirmation", fingerprint });
  }

  // 4. Parse and verify: evidence must appear verbatim in the email.
  const result = template.parse(body);
  const failure = !result.ok
    ? `parse_${result.reason}`
    : !verifyEvidence(result.raw, body)
      ? "not_verbatim"
      : null;
  if (!result.ok || failure) {
    await emit("receipt.failed", { receiptId, reason: failure ?? "parse_error" });
    return finish({ ...authed, state: "failed", fingerprint, templateId: template.id });
  }

  // 5. Deduplicate by (userId, bankTransactionRef).
  const ref = result.fields.bankTransactionRef;
  if (await deps.store.findParsedByRef(user.userId, ref)) {
    return finish({ ...authed, state: "duplicate", fingerprint, bankTransactionRef: ref });
  }

  const outcome = await finish({
    ...authed,
    state: "parsed",
    fingerprint,
    templateId: template.id,
    templateVersion: template.version,
    bankTransactionRef: ref,
    fields: result.fields,
  });
  await emit("receipt.parsed", {
    receiptId,
    ...result.fields,
    source: "parser",
    templateId: template.id,
    templateVersion: template.version,
    fxProvisional: false,
  });
  return outcome;
}
