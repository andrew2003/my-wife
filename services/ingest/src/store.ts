import type { ReceiptState } from "@my-wife/contracts";
import type { ParsedFields } from "./templates";

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
  templateId?: string;
  templateVersion?: number;
  bankTransactionRef?: string;
  fields?: ParsedFields;
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

  async save(record: ReceiptRecord) {
    this.records.push({ ...record });
  }

  size(): number {
    return this.records.length;
  }
}
