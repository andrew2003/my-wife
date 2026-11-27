import { SETTINGS, type EventEnvelope } from "@my-wife/contracts";
import { assertTransition } from "./receipt-state";
import type { PipelineDeps } from "./pipeline";
import type { ReceiptRecord } from "./store";
import { llmReadAttempts, stepAt, withSteps } from "./unknown-pipeline";
import {
  parseAmountVnd,
  toUtcIso,
  valuesOf,
  verifyEvidence,
  type ParsedFields,
  type RawEvidence,
  type TemplateParser,
} from "./templates";

/** Template learning (spec 11, sections 2.5 and 3). Pure rules plus small store calls. */

/** Parser data generated from one verified LLM read: label names, never code. */
export type ParserData = {
  amountLabel: string;
  direction: "in" | "out";
  refLabel: string;
  timeLabel: string;
  accountLabel: string;
  memoLabel?: string;
  /** Local bank time offset from UTC, in minutes. */
  utcOffsetMinutes: number;
};

export type LearnedTemplate = {
  id: string;
  userId: string;
  senderKey: string;
  fingerprint: string;
  state: "learning" | "trusted";
  version: number;
  parserData: ParserData;
  /** Consecutive parser reads that passed verification. */
  matchCount: number;
  /** Consecutive parser failures. */
  failureCount: number;
  /** Earlier parser versions, kept for audit. */
  history: { version: number; parserData: ParserData }[];
};

export interface TemplateStore {
  find(userId: string, senderKey: string, fingerprint: string): Promise<LearnedTemplate | null>;
  save(template: LearnedTemplate): Promise<void>;
}

export class MemoryTemplateStore implements TemplateStore {
  private readonly items = new Map<string, LearnedTemplate>();
  private static key(u: string, s: string, f: string) {
    return `${u}|${s}|${f}`;
  }
  async find(userId: string, senderKey: string, fingerprint: string) {
    const t = this.items.get(MemoryTemplateStore.key(userId, senderKey, fingerprint));
    return t ? structuredClone(t) : null;
  }
  async save(t: LearnedTemplate) {
    this.items.set(
      MemoryTemplateStore.key(t.userId, t.senderKey, t.fingerprint),
      structuredClone(t),
    );
  }
}

export type LearningDeps = { templates: TemplateStore };

/** The verified read of a mail, kept on the receipt until the user confirms it. */
export type VerifiedRead = {
  fields: ParsedFields;
  raw: RawEvidence;
  parserData: ParserData;
  confidence: number;
};

export type LearningSettings = {
  confidenceFloor: number;
  promotionMatches: number;
  demotionFailures: number;
  firstConfirmation: boolean;
};

/** User settings with the registry default as fallback; never a literal here. */
export function learningSettings(s: PipelineDeps["settings"]): LearningSettings {
  return {
    confidenceFloor: s.llmConfidenceFloor ?? SETTINGS["ingest.llm_confidence_floor"].default,
    promotionMatches:
      s.templatePromotionMatches ?? SETTINGS["ingest.template_promotion_matches"].default,
    demotionFailures:
      s.templateDemotionFailures ?? SETTINGS["ingest.template_demotion_failures"].default,
    firstConfirmation:
      s.templateFirstConfirmation ?? SETTINGS["ingest.template_first_confirmation"].default,
  };
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** "26/11/2026 10:15:30" for an ISO time with an explicit offset; null without one. */
function localWallTime(iso: string): { text: string; offsetMinutes: number } | null {
  const m = /([+-])(\d{2}):(\d{2})$/.exec(iso);
  if (!m || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(iso)) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const offsetMinutes = (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  const d = new Date(ms + offsetMinutes * 60_000);
  const text = `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${pad(
    d.getUTCHours(),
  )}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return { text, offsetMinutes };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The integer written in the mail as a whole number: plain, or grouped with "," or ".". */
function amountAppears(amount: number, body: string): boolean {
  const plain = String(amount);
  const grouped = plain.replace(/\B(?=(\d{3})+(?!\d))/g, "{sep}");
  const forms = new Set([
    plain,
    grouped.replace(/\{sep\}/g, ","),
    grouped.replace(/\{sep\}/g, "."),
  ]);
  return [...forms].some((f) =>
    new RegExp(`(?<![\\d])(?<![\\d][.,])${escapeRe(f)}(?![\\d])(?![.,]\\d)`).test(body),
  );
}

const refAppears = (ref: string, body: string) =>
  new RegExp(`(?<![A-Za-z0-9])${escapeRe(ref)}(?![A-Za-z0-9])`).test(body);

export type LlmReadVerdict = { ok: true; read: VerifiedRead } | { ok: false; reason: string };

const VND_SUFFIX = /\s*VND$/;

/**
 * Verifies what the model proposed against the mail. The amount, reference and time must
 * appear verbatim in the body and the confidence must reach the floor. The booked fields are
 * then read again by a generated parser, so the model's values are never stored directly.
 */
export function verifyLlmRead(input: {
  fields: Record<string, unknown> | null;
  confidence: number;
  body: string;
  confidenceFloor: number;
}): LlmReadVerdict {
  const { fields, body } = input;
  const no = (reason: string): LlmReadVerdict => ({ ok: false, reason });
  if (!fields) return no("no_fields");
  if (!(input.confidence >= input.confidenceFloor)) return no("low_confidence");

  const amount = fields.amountVnd;
  const reference = fields.reference;
  const occurredAt = fields.occurredAt;
  const tail = fields.accountTail;
  const direction = fields.direction;
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0)
    return no("amount_invalid");
  if (typeof reference !== "string" || reference.length === 0) return no("reference_missing");
  if (typeof occurredAt !== "string") return no("time_missing");
  if (typeof tail !== "string" || !/^\d{3,}$/.test(tail)) return no("account_missing");
  if (direction !== "in" && direction !== "out") return no("direction_invalid");
  if ((fields.currency ?? "VND") !== "VND") return no("currency_unsupported");

  if (!amountAppears(amount, body)) return no("amount_not_verbatim");
  if (!refAppears(reference, body)) return no("reference_not_verbatim");
  const wall = localWallTime(occurredAt);
  if (!wall) return no("time_offset_missing");
  if (!body.includes(wall.text)) return no("time_not_verbatim");

  // Generate the parser (data) from the lines the facts were found on, then re-read the mail.
  const values = valuesOf(body);
  const labelWhere = (test: (v: string) => boolean) => [...values].find(([, v]) => test(v))?.[0];
  const amountLabel = labelWhere((v) => parseAmountVnd(v.replace(VND_SUFFIX, "")) === amount);
  const refLabel = labelWhere((v) => v === reference);
  const timeLabel = labelWhere((v) => v === wall.text);
  const accountLabel = labelWhere((v) => /(\d{3,})$/.exec(v)?.[1] === tail);
  const memo = fields.memo;
  const memoLabel =
    typeof memo === "string" && memo.length > 0 ? labelWhere((v) => v === memo) : undefined;
  if (!amountLabel || !refLabel || !timeLabel || !accountLabel) return no("parser_unsupported");

  const parserData: ParserData = {
    amountLabel,
    direction,
    refLabel,
    timeLabel,
    accountLabel,
    ...(memoLabel ? { memoLabel } : {}),
    utcOffsetMinutes: wall.offsetMinutes,
  };
  const reread = parserFromData("probe", 1, parserData).parse(body);
  if (
    !reread.ok ||
    reread.fields.amountVnd !== amount ||
    reread.fields.bankTransactionRef !== reference ||
    reread.fields.bankAccountHint !== tail ||
    reread.fields.direction !== direction ||
    reread.fields.occurredAt !== new Date(Date.parse(occurredAt)).toISOString() ||
    !verifyEvidence(reread.raw, body)
  )
    return no("parser_mismatch");
  return {
    ok: true,
    read: { fields: reread.fields, raw: reread.raw, parserData, confidence: input.confidence },
  };
}

/** Interprets parser data: a pure function of the mail body. */
export function parserFromData(id: string, version: number, data: ParserData): TemplateParser {
  return {
    id,
    version,
    parse(body) {
      const v = valuesOf(body);
      const fail = (reason: string) => ({ ok: false as const, reason });
      const amountText = (v.get(data.amountLabel) ?? "").replace(VND_SUFFIX, "");
      const amountVnd = parseAmountVnd(amountText);
      if (amountVnd === null) return fail("amount");
      const ref = v.get(data.refLabel) ?? "";
      if (!/^[A-Za-z0-9]{4,40}$/.test(ref)) return fail("ref");
      const timeText = v.get(data.timeLabel) ?? "";
      const occurredAt = toUtcIso(timeText, data.utcOffsetMinutes);
      if (!occurredAt) return fail("time");
      const hint = /(\d{3,})$/.exec(v.get(data.accountLabel) ?? "")?.[1];
      if (!hint) return fail("account");
      return {
        ok: true as const,
        raw: { amount: amountText, ref, time: timeText },
        fields: {
          bankTransactionRef: ref,
          bankAccountHint: hint,
          direction: data.direction,
          amountVnd,
          currency: "VND",
          counterparty: null,
          memo: data.memoLabel ? (v.get(data.memoLabel) ?? "") : "",
          occurredAt,
        },
      };
    },
  };
}

function emitter(deps: PipelineDeps, userId: string, now: Date) {
  return (type: EventEnvelope["type"], payload: unknown) =>
    deps.publish({
      id: deps.newId(),
      type,
      occurredAt: now.toISOString(),
      userId,
      schemaVersion: 1,
      payload,
    } as EventEnvelope);
}

/** A parser read that passed verification. Promotes a learning template at the Nth match. */
export async function recordMatch(
  deps: PipelineDeps,
  tpl: LearnedTemplate,
  now: Date,
): Promise<void> {
  const learning = deps.learning;
  if (!learning) return;
  const s = learningSettings(deps.settings);
  const next: LearnedTemplate = { ...tpl, failureCount: 0 };
  let promoted = false;
  if (tpl.state === "learning") {
    next.matchCount = tpl.matchCount + 1;
    if (next.matchCount >= s.promotionMatches) {
      next.state = "trusted";
      promoted = true;
    }
  }
  await learning.templates.save(next);
  if (promoted)
    await emitter(
      deps,
      tpl.userId,
      now,
    )("template.promoted", {
      templateId: tpl.id,
      version: tpl.version,
    });
}

/** A parser read that failed. Resets a learning counter; demotes a trusted template. */
export async function recordFailure(
  deps: PipelineDeps,
  tpl: LearnedTemplate,
  now: Date,
): Promise<void> {
  const learning = deps.learning;
  if (!learning) return;
  const s = learningSettings(deps.settings);
  const next: LearnedTemplate = { ...tpl, matchCount: 0 };
  let demoted = false;
  if (tpl.state === "trusted") {
    next.failureCount = tpl.failureCount + 1;
    if (next.failureCount >= s.demotionFailures) {
      next.state = "learning";
      next.failureCount = 0;
      next.version = tpl.version + 1;
      next.history = [...tpl.history, { version: tpl.version, parserData: tpl.parserData }];
      demoted = true;
    }
  }
  await learning.templates.save(next);
  if (demoted)
    await emitter(
      deps,
      tpl.userId,
      now,
    )("template.demoted", {
      templateId: tpl.id,
      version: next.version,
    });
}

/**
 * Consumer of `ai.template_read_result`. A read that fails verification leaves the receipt in
 * `needs_confirmation`, books nothing and announces it again so the anomaly stays open.
 */
export async function handleTemplateReadResult(
  deps: PipelineDeps,
  event: EventEnvelope,
  now: Date,
): Promise<void> {
  if (event.type !== "ai.template_read_result") return;
  const { receiptId, fields, confidence } = event.payload as {
    receiptId: string;
    fields: Record<string, unknown> | null;
    confidence: number;
  };
  const record = await deps.store.findById(receiptId);
  if (
    !record ||
    record.userId !== event.userId ||
    record.state !== "needs_confirmation" ||
    !record.mail ||
    record.llmRead
  )
    return;
  const emit = emitter(deps, record.userId, now);
  const verdict = verifyLlmRead({
    fields,
    confidence,
    body: record.mail.body,
    confidenceFloor: learningSettings(deps.settings).confidenceFloor,
  });
  const received = stepAt("read", "received", now);
  if (!verdict.ok) {
    const attempts = (record.readAttempts ?? 0) + 1;
    const verify = stepAt("verify", verdict.reason, now);
    if (attempts >= llmReadAttempts(deps.settings.llmReadAttempts)) {
      // Verification failed too often: nothing is booked and the anomaly inbox keeps the mail.
      assertTransition(record.state, "failed");
      await deps.store.save(
        withSteps(
          { ...record, state: "failed" as const, readAttempts: attempts },
          received,
          verify,
        ),
      );
      await emit("receipt.failed", { receiptId, reason: verdict.reason });
      return;
    }
    await deps.store.save(withSteps({ ...record, readAttempts: attempts }, received, verify));
    await emit("receipt.unknown", {
      receiptId,
      templateFingerprint: record.fingerprint ?? "unknown",
      sender: record.senderKey ?? record.sender ?? "unknown",
    });
    return;
  }
  // Step 6: the bank reference may already be booked from another mail.
  const ref = verdict.read.fields.bankTransactionRef;
  if (await deps.store.findParsedByRef(record.userId, ref)) {
    assertTransition(record.state, "duplicate");
    const { mail: _mail, ...rest } = record;
    await deps.store.save(
      withSteps(
        { ...rest, state: "duplicate" as const, bankTransactionRef: ref },
        received,
        stepAt("verify", "pass", now),
        stepAt("deduplicate_reference", "duplicate", now),
      ),
    );
    return;
  }
  await deps.store.save(
    withSteps(
      { ...record, llmRead: verdict.read },
      received,
      stepAt("verify", "pass", now),
      stepAt("deduplicate_reference", "pass", now),
      stepAt("learn", "parser_generated", now),
    ),
  );
  if (!learningSettings(deps.settings).firstConfirmation)
    await confirmTemplateRead(deps, record.userId, receiptId, now);
}

export type ConfirmResult =
  { ok: true } | { ok: false; code: "not_found" | "no_verified_read" | "duplicate_ref" };

/** The user confirms the first read: the receipt is booked and the template starts learning. */
export async function confirmTemplateRead(
  deps: PipelineDeps,
  userId: string,
  receiptId: string,
  now: Date,
): Promise<ConfirmResult> {
  const record = await deps.store.findById(receiptId);
  if (!record || record.userId !== userId) return { ok: false, code: "not_found" };
  const read = record.llmRead;
  if (!read || record.state !== "needs_confirmation" || !deps.learning)
    return { ok: false, code: "no_verified_read" };
  const ref = read.fields.bankTransactionRef;
  if (await deps.store.findParsedByRef(userId, ref)) return { ok: false, code: "duplicate_ref" };
  assertTransition(record.state, "parsed");

  if (record.senderKey && record.fingerprint) {
    const existing = await deps.learning.templates.find(
      userId,
      record.senderKey,
      record.fingerprint,
    );
    const tpl: LearnedTemplate = existing
      ? {
          ...existing,
          parserData: read.parserData,
          matchCount: 0,
          failureCount: 0,
          state: "learning",
        }
      : {
          id: deps.newId(),
          userId,
          senderKey: record.senderKey,
          fingerprint: record.fingerprint,
          state: "learning",
          version: 1,
          parserData: read.parserData,
          matchCount: 0,
          failureCount: 0,
          history: [],
        };
    await deps.learning.templates.save(tpl);
    await finishConfirmed(deps, record, tpl, now);
  } else {
    return { ok: false, code: "no_verified_read" };
  }
  return { ok: true };
}

async function finishConfirmed(
  deps: PipelineDeps,
  record: ReceiptRecord,
  tpl: LearnedTemplate,
  now: Date,
): Promise<void> {
  const read = record.llmRead as VerifiedRead;
  const { mail: _mail, llmRead: _read, ...rest } = record;
  await deps.store.save(
    withSteps(
      {
        ...rest,
        state: "parsed" as const,
        fields: read.fields,
        bankTransactionRef: read.fields.bankTransactionRef,
        templateId: tpl.id,
        templateVersion: tpl.version,
        source: "llm" as const,
      },
      stepAt("emit", "receipt.parsed", now),
    ),
  );
  await emitter(
    deps,
    record.userId,
    now,
  )("receipt.parsed", {
    receiptId: record.id,
    ...read.fields,
    source: "llm",
    templateId: tpl.id,
    templateVersion: tpl.version,
    confidence: read.confidence,
    fxProvisional: false,
  });
}
