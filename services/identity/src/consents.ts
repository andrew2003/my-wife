import type { ConsentKind, SupervisionLevel } from "@my-wife/contracts";

export type ConsentRecord = {
  userId: string;
  kind: ConsentKind;
  textVersion: number;
  grantedAt: string;
  revokedAt: string | null;
};

export type ConsentAuditRecord = {
  id: string;
  userId: string;
  kind: ConsentKind;
  action: "granted" | "revoked";
  textVersion: number;
  at: string;
};

/** Port: the Drizzle implementation is a follow-up (see docs/decisions.md). */
export interface ConsentStore {
  find(userId: string, kind: ConsentKind): Promise<ConsentRecord | undefined>;
  save(record: ConsentRecord, audit: ConsentAuditRecord): Promise<void>;
  list(userId: string): Promise<ConsentRecord[]>;
  listAudit(userId: string): Promise<ConsentAuditRecord[]>;
}

export function createConsentStore(): ConsentStore {
  const records = new Map<string, ConsentRecord>();
  const audit: ConsentAuditRecord[] = [];
  return {
    async find(userId, kind) {
      return records.get(`${userId}:${kind}`);
    },
    async save(record, entry) {
      records.set(`${record.userId}:${record.kind}`, record);
      audit.push(entry);
    },
    async list(userId) {
      return [...records.values()].filter((r) => r.userId === userId);
    },
    async listAudit(userId) {
      return audit.filter((a) => a.userId === userId);
    },
  };
}

export type ConsentStatus =
  | { granted: true; textVersion: number }
  | {
      granted: false;
      reason: "never_granted" | "revoked" | "text_outdated";
      requiredTextVersion: number;
    };

/** Pure: a consent counts only when granted, not revoked, and for the current text version. */
export function evaluateConsent(
  record: ConsentRecord | undefined,
  requiredTextVersion: number,
): ConsentStatus {
  if (!record) return { granted: false, reason: "never_granted", requiredTextVersion };
  if (record.revokedAt) return { granted: false, reason: "revoked", requiredTextVersion };
  if (record.textVersion < requiredTextVersion)
    return { granted: false, reason: "text_outdated", requiredTextVersion };
  return { granted: true, textVersion: record.textVersion };
}

/** Without the camera consent a camera-based level drops to `no_camera`. */
export function effectiveSupervisionLevel(
  requested: SupervisionLevel,
  cameraGranted: boolean,
): SupervisionLevel {
  if (cameraGranted) return requested;
  return requested === "full" || requested === "graduated" ? "no_camera" : requested;
}
