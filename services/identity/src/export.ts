import type { ConsentAuditRecord, ConsentRecord } from "./consents";
import type { OnboardingStepRecord, SettingAuditRecord, UserRecord } from "./store";

/** What the archive holds. Allow-list only: keys, tokens, hashes and sessions are never copied. */
export type ExportArchive = {
  generatedAt: string;
  profile: Pick<UserRecord, "id" | "email" | "role" | "locale" | "state">;
  settings: Record<string, unknown>;
  settingHistory: Array<Pick<SettingAuditRecord, "key" | "before" | "after" | "at">>;
  consents: Array<Pick<ConsentRecord, "kind" | "textVersion" | "grantedAt" | "revokedAt">>;
  consentHistory: Array<Pick<ConsentAuditRecord, "kind" | "action" | "textVersion" | "at">>;
  onboarding: Array<Pick<OnboardingStepRecord, "step" | "skipped" | "completedAt">>;
};

export type ExportInput = {
  user: UserRecord;
  settings: Record<string, unknown>;
  settingAudit: SettingAuditRecord[];
  consents: ConsentRecord[];
  consentAudit: ConsentAuditRecord[];
  onboarding: OnboardingStepRecord[];
  now: Date;
};

/** Pure: builds each field explicitly, so a new store column can never leak into the export. */
export function buildExportArchive(i: ExportInput): ExportArchive {
  return {
    generatedAt: i.now.toISOString(),
    profile: {
      id: i.user.id,
      email: i.user.email,
      role: i.user.role,
      locale: i.user.locale,
      state: i.user.state,
    },
    settings: i.settings,
    settingHistory: i.settingAudit.map((a) => ({
      key: a.key,
      before: a.before,
      after: a.after,
      at: a.at,
    })),
    consents: i.consents.map((c) => ({
      kind: c.kind,
      textVersion: c.textVersion,
      grantedAt: c.grantedAt,
      revokedAt: c.revokedAt,
    })),
    consentHistory: i.consentAudit.map((a) => ({
      kind: a.kind,
      action: a.action,
      textVersion: a.textVersion,
      at: a.at,
    })),
    onboarding: i.onboarding.map((s) => ({
      step: s.step,
      skipped: s.skipped,
      completedAt: s.completedAt,
    })),
  };
}

export type ExportRecord = { userId: string; expiresAt: string; archive: ExportArchive };

/** Port: holds a built archive under the hash of its one-time download token. */
export interface ExportStore {
  save(tokenHash: string, record: ExportRecord): Promise<void>;
  find(tokenHash: string): Promise<ExportRecord | undefined>;
}

export function createExportStore(): ExportStore {
  const records = new Map<string, ExportRecord>();
  return {
    async save(hash, record) {
      records.set(hash, record);
    },
    async find(hash) {
      return records.get(hash);
    },
  };
}
