import type { ReceiptState } from "@my-wife/contracts";
import type { VerifiedRead } from "./learning";
import type { ParsedFields } from "./templates";
import type { StepRecord } from "./unknown-pipeline";

/** Receipt metadata and normalized facts. The raw message body is not kept here. */
export type ReceiptRecord = {
  id: string;
  userId: string;
  state: ReceiptState;
  messageId: string | null;
  sender: string | null;
  sizeBytes: number;
  receivedAt: string;
  dkimResult: "pass" | "fail" | "none";
  rejectReason?: string;
  fingerprint?: string;
  /** Key of the mapped bank sender; set with the fingerprint for an unknown layout. */
  senderKey?: string;
  /** Where the booked fields came from; the first confirmed read is `llm`. */
  source?: "parser" | "llm";
  /** A model read that passed verification, waiting for the user to confirm it. */
  llmRead?: VerifiedRead;
  /** Audit trace of the unknown-receipt pipeline steps this receipt has been through. */
  steps?: StepRecord[];
  /** Model reads of this mail that failed verification. */
  readAttempts?: number;
  templateId?: string;
  templateVersion?: number;
  bankTransactionRef?: string;
  fields?: ParsedFields;
  /** Foreign-card purchase key shared by an authorization and its debit. */
  pairKey?: string;
  /** Set on a consumed authorization: the debit receipt it was paired with. */
  pairedReceiptId?: string;
  /**
   * Subject and text body, kept only for a mail with an unknown layout so the ai service can
   * read it (template.read_requested). Never set for parsed or rejected receipts.
   * TODO(encryption): spec 11 requires the body encrypted at rest with retention; this
   * plaintext field is for the in-memory store only. A persistent store must encrypt it and
   * purge it on a retention schedule first.
   */
  mail?: { subject: string; body: string };
};

/**
 * Persistence port. A Postgres implementation must back `findParsedByRef` with a unique
 * index on (user_id, bank_transaction_ref) for parsed receipts so concurrent mails cannot
 * both reach `parsed`.
 */
export interface IngestStore {
  /** Must match only `parsed` or `duplicate` receipts, never `rejected` ones. */
  findByMessageId(userId: string, messageId: string): Promise<ReceiptRecord | null>;
  findParsedByRef(userId: string, bankTransactionRef: string): Promise<ReceiptRecord | null>;
  /** Latest held foreign-card authorization (state `parsing`) of the purchase, if any. */
  findHeldByPairKey(userId: string, pairKey: string): Promise<ReceiptRecord | null>;
  /** Latest `parsed` receipt carrying the purchase key, if any. */
  findParsedByPairKey(userId: string, pairKey: string): Promise<ReceiptRecord | null>;
  /** Receipt by id, whoever owns it; callers must check `userId`. */
  findById(receiptId: string): Promise<ReceiptRecord | null>;
  /** Inserts the record, or replaces the one with the same id. */
  save(record: ReceiptRecord): Promise<void>;
}

export class MemoryIngestStore implements IngestStore {
  private readonly records: ReceiptRecord[] = [];

  async findByMessageId(userId: string, messageId: string) {
    // Only parsed or duplicate receipts count; a rejected forgery must not block the genuine mail.
    return (
      this.records.find(
        (r) =>
          r.userId === userId &&
          r.messageId === messageId &&
          (r.state === "parsed" || r.state === "duplicate"),
      ) ?? null
    );
  }

  async findParsedByRef(userId: string, ref: string) {
    return (
      this.records.find(
        (r) => r.userId === userId && r.state === "parsed" && r.bankTransactionRef === ref,
      ) ?? null
    );
  }

  private latest(userId: string, pairKey: string, state: ReceiptState) {
    return (
      [...this.records]
        .reverse()
        .find((r) => r.userId === userId && r.state === state && r.pairKey === pairKey) ?? null
    );
  }

  async findHeldByPairKey(userId: string, pairKey: string) {
    return this.latest(userId, pairKey, "parsing");
  }

  async findParsedByPairKey(userId: string, pairKey: string) {
    return this.latest(userId, pairKey, "parsed");
  }

  async findById(receiptId: string) {
    return this.records.find((r) => r.id === receiptId) ?? null;
  }

  async save(record: ReceiptRecord) {
    const at = this.records.findIndex((r) => r.id === record.id);
    if (at >= 0) this.records[at] = { ...record };
    else this.records.push({ ...record });
  }

  size(): number {
    return this.records.length;
  }
}
