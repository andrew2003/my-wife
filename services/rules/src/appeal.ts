import { randomUUID } from "node:crypto";
import {
  EVENT_SCHEMA_VERSION,
  SETTINGS,
  type EventEnvelope,
  type EventPayload,
  type ConsentKind,
} from "@my-wife/contracts";
import type { FaultAuditRecord, FaultStore } from "./fault";
import type { PenaltyAuditRecord, PenaltyStore } from "./penalty";

const HOUR_MS = 3_600_000;

export type AppealSubjectKind = "fault" | "classification" | "wake_photo_grade" | "trial_summary";
export type AppealOutcome = "upheld" | "overturned";

/** Appeal settings of one user; the default comes from the registry. */
export type AppealSettings = { windowHours: number };
export const DEFAULT_APPEAL_SETTINGS: AppealSettings = {
  windowHours: SETTINGS["appeal.window_hours"].default,
};

export type AppealRecord = {
  id: string;
  subjectKind: AppealSubjectKind;
  subjectId: string;
  /** Penalty held while the appeal is open; null when the appeal holds no penalty. */
  penaltyId: string | null;
  status: "open" | AppealOutcome;
  reasonText: string;
  openedAt: string;
  windowEndsAt: string;
  hasEvidenceFrame: boolean;
  decidedAt: string | null;
  decisionNote: string | null;
};

export type AppealAuditRecord = {
  id: string;
  appealId: string;
  action: "appeal.opened" | "appeal.decided" | "appeal.frame_attached" | "appeal.frame_deleted";
  at: string;
  detail: Record<string, unknown>;
};

type Stored = {
  appeal: AppealRecord;
  openedPublished: boolean;
  decidedPublished: boolean;
};

export interface AppealStore {
  /** Synchronously inserts the appeal with its audit record. */
  insert(userId: string, appeal: AppealRecord, audit: AppealAuditRecord): void;
  find(userId: string, appealId: string): AppealRecord | undefined;
  findOpen(userId: string, subjectKind: string, subjectId: string): AppealRecord | undefined;
  /** Synchronously moves an open appeal to its outcome; undefined when it is not open. */
  decide(
    userId: string,
    appealId: string,
    outcome: AppealOutcome,
    at: string,
    note: string | null,
    audit: AppealAuditRecord,
  ): AppealRecord | undefined;
  markPublished(userId: string, appealId: string, kind: "opened" | "decided"): void;
  /** Sets the evidence-frame flag of an appeal and writes the audit record. */
  setEvidenceFrame(
    userId: string,
    appealId: string,
    present: boolean,
    audit: AppealAuditRecord,
  ): boolean;
  /** Appeals with an owed event, oldest first. */
  owed(userId: string): { appeal: AppealRecord; kind: "opened" | "decided" }[];
  list(userId: string): readonly AppealRecord[];
  audit(userId: string): readonly AppealAuditRecord[];
}

/**
 * Holds the single consented appeal frame until the decision. A real implementation must be
 * short-lived storage; nothing else in the service keeps image data.
 */
export interface AppealFrameStore {
  put(userId: string, appealId: string, frameBase64: string): void;
  has(userId: string, appealId: string): boolean;
  /** Removes the frame; true when one existed. */
  delete(userId: string, appealId: string): boolean;
}

export class InMemoryAppealFrameStore implements AppealFrameStore {
  private readonly frames = new Map<string, string>();
  private key(userId: string, appealId: string) {
    return `${userId}:${appealId}`;
  }
  put(userId: string, appealId: string, frameBase64: string) {
    this.frames.set(this.key(userId, appealId), frameBase64);
  }
  has(userId: string, appealId: string) {
    return this.frames.has(this.key(userId, appealId));
  }
  delete(userId: string, appealId: string) {
    return this.frames.delete(this.key(userId, appealId));
  }
}

export class InMemoryAppealStore implements AppealStore {
  private readonly rows = new Map<string, Stored[]>();
  private readonly audits = new Map<string, AppealAuditRecord[]>();

  private row(userId: string, appealId: string) {
    return this.rows.get(userId)?.find((r) => r.appeal.id === appealId);
  }
  private addAudit(userId: string, audit: AppealAuditRecord) {
    this.audits.set(userId, [...(this.audits.get(userId) ?? []), Object.freeze(audit)]);
  }
  insert(userId: string, appeal: AppealRecord, audit: AppealAuditRecord) {
    const list = this.rows.get(userId) ?? [];
    list.push({
      appeal: Object.freeze(appeal),
      openedPublished: false,
      decidedPublished: false,
    });
    this.rows.set(userId, list);
    this.addAudit(userId, audit);
  }
  find(userId: string, appealId: string) {
    return this.row(userId, appealId)?.appeal;
  }
  findOpen(userId: string, subjectKind: string, subjectId: string) {
    return this.rows
      .get(userId)
      ?.find(
        (r) =>
          r.appeal.status === "open" &&
          r.appeal.subjectKind === subjectKind &&
          r.appeal.subjectId === subjectId,
      )?.appeal;
  }
  decide(
    userId: string,
    appealId: string,
    outcome: AppealOutcome,
    at: string,
    note: string | null,
    audit: AppealAuditRecord,
  ) {
    const row = this.row(userId, appealId);
    if (!row || row.appeal.status !== "open") return undefined;
    row.appeal = Object.freeze({
      ...row.appeal,
      status: outcome,
      decidedAt: at,
      decisionNote: note,
    });
    this.addAudit(userId, audit);
    return row.appeal;
  }
  setEvidenceFrame(userId: string, appealId: string, present: boolean, audit: AppealAuditRecord) {
    const row = this.row(userId, appealId);
    if (!row) return false;
    row.appeal = Object.freeze({ ...row.appeal, hasEvidenceFrame: present });
    this.addAudit(userId, audit);
    return true;
  }
  markPublished(userId: string, appealId: string, kind: "opened" | "decided") {
    const row = this.row(userId, appealId);
    if (!row) return;
    if (kind === "opened") row.openedPublished = true;
    else row.decidedPublished = true;
  }
  owed(userId: string) {
    const out: { appeal: AppealRecord; kind: "opened" | "decided" }[] = [];
    for (const r of this.rows.get(userId) ?? []) {
      if (!r.openedPublished) out.push({ appeal: r.appeal, kind: "opened" });
      // The decision event exists for fault appeals only (the only contract event).
      if (r.appeal.status !== "open" && r.appeal.subjectKind === "fault" && !r.decidedPublished)
        out.push({ appeal: r.appeal, kind: "decided" });
    }
    return out;
  }
  list(userId: string) {
    return (this.rows.get(userId) ?? []).map((r) => r.appeal);
  }
  audit(userId: string) {
    return this.audits.get(userId) ?? [];
  }
}

export type OpenAppealInput = {
  subjectKind: AppealSubjectKind;
  subjectId: string;
  reasonText: string;
  /** Penalty to suspend while the appeal is open. */
  penaltyId?: string;
};

export type AppealError =
  | "rules.invalid_appeal"
  | "rules.subject_not_found"
  | "rules.subject_not_appealable"
  | "rules.penalty_not_from_fault"
  | "rules.appeal_window_closed"
  | "rules.appeal_already_open";

export type OpenAppealResult =
  { ok: true; appeal: AppealRecord } | { ok: false; error: AppealError };
export type DecideAppealResult =
  | { ok: true; appeal: AppealRecord }
  | {
      ok: false;
      error: "rules.appeal_not_found" | "rules.appeal_already_decided" | "rules.fault_not_appealed";
    };

export type AttachFrameResult =
  | { ok: true; appeal: AppealRecord }
  | {
      ok: false;
      error:
        | "rules.invalid_appeal"
        | "rules.appeal_not_found"
        | "rules.appeal_already_decided"
        | "rules.frame_already_attached"
        | "rules.consent_missing";
    };

export type AppealServiceDeps = {
  store: AppealStore;
  /** Where the consented frame lives until the decision; without it no frame is accepted. */
  frameStore?: AppealFrameStore;
  /** Tells whether the user currently holds a consent (identity); false when absent. */
  hasConsent?: (userId: string, kind: ConsentKind) => Promise<boolean>;
  faultStore: FaultStore;
  penaltyStore: PenaltyStore;
  publish?: (event: EventEnvelope) => void | Promise<void>;
  /** The user's appeal settings; registry defaults when absent. */
  readSettings?: (userId: string) => Promise<AppealSettings>;
  /**
   * Longest gap between a fault and the penalty issued for it (the penalty is issued at week
   * close); a structural guard, 14 days by default.
   */
  maxPenaltyLagMs?: number;
  newId?: () => string;
  onPublishError?: (err: unknown) => void;
};

/** Every method takes `now`; nothing here reads the system clock. */
export function createAppealService(deps: AppealServiceDeps) {
  const newId = deps.newId ?? randomUUID;
  const readSettings = deps.readSettings ?? (async () => DEFAULT_APPEAL_SETTINGS);
  const maxLagMs = deps.maxPenaltyLagMs ?? 14 * 24 * HOUR_MS;
  const claimed = new Set<string>();

  /** Deletes the frame of a decided appeal and records it; a failure leaves it for a retry. */
  function purgeFrame(userId: string, appeal: AppealRecord, now: Date): void {
    if (!deps.frameStore || !appeal.hasEvidenceFrame || appeal.status === "open") return;
    try {
      deps.frameStore.delete(userId, appeal.id);
    } catch (err) {
      deps.onPublishError?.(err);
      return;
    }
    deps.store.setEvidenceFrame(userId, appeal.id, false, {
      id: newId(),
      appealId: appeal.id,
      action: "appeal.frame_deleted",
      at: now.toISOString(),
      detail: {},
    });
  }

  async function emitOwed(userId: string, now: Date): Promise<void> {
    for (const { appeal, kind } of deps.store.owed(userId)) {
      const key = `${kind}:${appeal.id}`;
      if (claimed.has(key)) continue;
      claimed.add(key);
      const base = { userId, schemaVersion: EVENT_SCHEMA_VERSION, occurredAt: now.toISOString() };
      // Deterministic ids: a retry after an ambiguous publish carries the same id.
      const event =
        kind === "opened"
          ? {
              ...base,
              id: `appeal-opened-${appeal.id}`,
              type: "appeal.opened",
              payload: {
                appealId: appeal.id,
                subjectKind: appeal.subjectKind,
                subjectId: appeal.subjectId,
              } satisfies EventPayload<"appeal.opened">,
            }
          : {
              ...base,
              id: `appeal-decided-${appeal.id}`,
              type: "fault.appeal_decided",
              payload: {
                appealId: appeal.id,
                faultId: appeal.subjectId,
                outcome: appeal.status as AppealOutcome,
              } satisfies EventPayload<"fault.appeal_decided">,
            };
      try {
        await deps.publish?.(event as EventEnvelope);
        deps.store.markPublished(userId, appeal.id, kind);
      } catch (err) {
        deps.onPublishError?.(err);
      } finally {
        claimed.delete(key);
      }
    }
  }

  return {
    /**
     * Opens an appeal inside the window (`appeal.window_hours` after the penalty was issued or
     * the fault happened, whichever is later), suspends the linked penalty and marks the fault
     * `appealed`. Emits `appeal.opened`.
     */
    async open(userId: string, input: OpenAppealInput, now: Date): Promise<OpenAppealResult> {
      const reasonText = input.reasonText.trim();
      if (reasonText === "") return { ok: false, error: "rules.invalid_appeal" };

      const fault =
        input.subjectKind === "fault"
          ? deps.faultStore.list(userId).find((f) => f.id === input.subjectId)
          : undefined;
      if (input.subjectKind === "fault" && !fault)
        return { ok: false, error: "rules.subject_not_found" };
      const penalty = input.penaltyId
        ? deps.penaltyStore.list(userId).find((p) => p.id === input.penaltyId)
        : undefined;
      if (input.penaltyId && !penalty) return { ok: false, error: "rules.subject_not_found" };
      // Other subject kinds are appealable through the penalty they caused.
      if (!fault && !penalty) return { ok: false, error: "rules.subject_not_found" };
      if (
        deps.store.findOpen(userId, input.subjectKind, input.subjectId) ||
        (penalty && penalty.appealId)
      )
        return { ok: false, error: "rules.appeal_already_open" };

      // The ledger has no fault link on a penalty, so the match is by user, source (a fault
      // penalty is monitoring or routine) and time (issued after the fault, within one lag).
      if (fault && penalty) {
        const lag = Date.parse(penalty.issuedAt) - Date.parse(fault.occurredAt);
        if (
          (penalty.source !== "monitoring" && penalty.source !== "routine") ||
          lag < 0 ||
          lag > maxLagMs
        )
          return { ok: false, error: "rules.penalty_not_from_fault" };
      }
      if (
        (fault && fault.status !== "recorded") ||
        (penalty && (penalty.reversedAt || penalty.status === "paid"))
      )
        return { ok: false, error: "rules.subject_not_appealable" };
      const { windowHours } = await readSettings(userId);
      const hours =
        Number.isInteger(windowHours) && windowHours > 0
          ? windowHours
          : DEFAULT_APPEAL_SETTINGS.windowHours;
      const start = Math.max(
        fault ? Date.parse(fault.occurredAt) : 0,
        penalty ? Date.parse(penalty.issuedAt) : 0,
      );
      const windowEnd = new Date(start + hours * HOUR_MS);
      if (now.getTime() > windowEnd.getTime())
        return { ok: false, error: "rules.appeal_window_closed" };

      const appeal: AppealRecord = {
        id: newId(),
        subjectKind: input.subjectKind,
        subjectId: input.subjectId,
        penaltyId: penalty?.id ?? null,
        status: "open",
        reasonText,
        openedAt: now.toISOString(),
        windowEndsAt: windowEnd.toISOString(),
        hasEvidenceFrame: false,
        decidedAt: null,
        decisionNote: null,
      };
      const at = now.toISOString();
      // Hold the penalty first; the fault transition is rolled back by releasing the hold.
      if (penalty) {
        const audit: PenaltyAuditRecord = {
          id: newId(),
          penaltyId: penalty.id,
          action: "penalty.appeal_hold",
          at,
          detail: { appealId: appeal.id, amountVnd: penalty.amountVnd },
        };
        if (!deps.penaltyStore.holdForAppeal(userId, penalty.id, appeal.id, audit))
          return { ok: false, error: "rules.appeal_already_open" };
      }
      if (fault) {
        const audit: FaultAuditRecord = {
          id: newId(),
          faultId: fault.id,
          action: "fault.appealed",
          at,
          detail: { appealId: appeal.id },
        };
        if (!deps.faultStore.transition(userId, fault.id, ["recorded"], "appealed", audit)) {
          if (penalty)
            deps.penaltyStore.releaseAppealHold(userId, penalty.id, appeal.id, {
              id: newId(),
              penaltyId: penalty.id,
              action: "penalty.appeal_released",
              at,
              detail: { appealId: appeal.id, reason: "rollback" },
            });
          return { ok: false, error: "rules.subject_not_appealable" };
        }
      }
      deps.store.insert(userId, appeal, {
        id: newId(),
        appealId: appeal.id,
        action: "appeal.opened",
        at,
        detail: { subjectKind: appeal.subjectKind, subjectId: appeal.subjectId },
      });
      await emitOwed(userId, now);
      return { ok: true, appeal };
    },

    /**
     * Records the decision. `overturned` removes the fault from totals and reverses the held
     * penalty; `upheld` keeps the fault and releases the hold so the penalty runs on. Emits
     * `fault.appeal_decided` for fault appeals. The decision itself comes from code on a hard
     * fact or from the user's accountability rules; the AI never decides.
     */
    async decide(
      userId: string,
      appealId: string,
      outcome: AppealOutcome,
      now: Date,
      note?: string,
    ): Promise<DecideAppealResult> {
      const existing = deps.store.find(userId, appealId);
      if (!existing) return { ok: false, error: "rules.appeal_not_found" };
      const at = now.toISOString();
      // A fault appeal can only be decided while its fault is still `appealed`.
      if (
        existing.status === "open" &&
        existing.subjectKind === "fault" &&
        deps.faultStore.list(userId).find((f) => f.id === existing.subjectId)?.status !== "appealed"
      )
        return { ok: false, error: "rules.fault_not_appealed" };
      const appeal = deps.store.decide(userId, appealId, outcome, at, note ?? null, {
        id: newId(),
        appealId,
        action: "appeal.decided",
        at,
        detail: { outcome, note: note ?? null },
      });
      if (!appeal) return { ok: false, error: "rules.appeal_already_decided" };

      if (appeal.subjectKind === "fault") {
        deps.faultStore.transition(userId, appeal.subjectId, ["appealed"], outcome, {
          id: newId(),
          faultId: appeal.subjectId,
          action: outcome === "overturned" ? "fault.overturned" : "fault.upheld",
          at,
          detail: { appealId },
        });
      }
      if (appeal.penaltyId) {
        const audit: PenaltyAuditRecord = {
          id: newId(),
          penaltyId: appeal.penaltyId,
          action: outcome === "overturned" ? "penalty.reversed" : "penalty.appeal_released",
          at,
          detail: { appealId, outcome },
        };
        if (outcome === "overturned")
          deps.penaltyStore.reverse(userId, appeal.penaltyId, appealId, at, audit);
        else deps.penaltyStore.releaseAppealHold(userId, appeal.penaltyId, appealId, audit);
      }
      purgeFrame(userId, appeal, now);
      await emitOwed(userId, now);
      return { ok: true, appeal: deps.store.find(userId, appealId) ?? appeal };
    },

    /**
     * Stores the single camera frame sent with an appeal. It needs the `vision_frame` consent at
     * this moment; the frame lives only until the decision, which deletes it.
     */
    async attachFrame(
      userId: string,
      appealId: string,
      frameBase64: string,
      now: Date,
    ): Promise<AttachFrameResult> {
      if (frameBase64.trim() === "") return { ok: false, error: "rules.invalid_appeal" };
      const appeal = deps.store.find(userId, appealId);
      if (!appeal) return { ok: false, error: "rules.appeal_not_found" };
      if (appeal.status !== "open") return { ok: false, error: "rules.appeal_already_decided" };
      if (appeal.hasEvidenceFrame) return { ok: false, error: "rules.frame_already_attached" };
      if (!deps.frameStore || !deps.hasConsent || !(await deps.hasConsent(userId, "vision_frame")))
        return { ok: false, error: "rules.consent_missing" };
      deps.frameStore.put(userId, appealId, frameBase64);
      deps.store.setEvidenceFrame(userId, appealId, true, {
        id: newId(),
        appealId,
        action: "appeal.frame_attached",
        at: now.toISOString(),
        detail: {},
      });
      return { ok: true, appeal: deps.store.find(userId, appealId)! };
    },

    /** Re-publishes events whose publish failed earlier and retries frame deletions. */
    async retryPending(userId: string, now: Date): Promise<void> {
      for (const a of deps.store.list(userId)) purgeFrame(userId, a, now);
      await emitOwed(userId, now);
    },

    list: (userId: string) => deps.store.list(userId),
  };
}

export type AppealService = ReturnType<typeof createAppealService>;
