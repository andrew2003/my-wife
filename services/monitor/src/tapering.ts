import { SETTINGS, type EventEnvelope, type SupervisionLevel } from "@my-wife/contracts";
import type { MonitorDeps } from "./monitoring";

const DAY_MS = 86_400_000;
/** A schedule week is 7 UTC days from its first day (docs/decisions.md, MW-030). */
const WEEK_DAYS = 7;
const ASK_KIND = "supervision_taper";
const SOURCE_SERVICE = "monitor";

/** Steps down one level at a time; `graduated` is the end of the road. */
const NEXT_LEVEL: Record<SupervisionLevel, SupervisionLevel | null> = {
  full: "no_camera",
  no_camera: "checklist_only",
  checklist_only: "graduated",
  graduated: null,
};

export interface TaperQuestion {
  questionId: string;
  from: SupervisionLevel;
  to: SupervisionLevel;
  /** When the lower level starts: the loosening lock never takes effect inside the current week. */
  effectiveFrom: string;
}

export interface SupervisionRecord {
  /** `null` until the first week review, when the user's setting gives the starting level. */
  level: SupervisionLevel | null;
  /** Consecutive clean weeks at the current level. */
  cleanWeeks: number;
  pending: TaperQuestion | null;
  /** Reviewed week ids, so a redelivered `week.closed` changes nothing. */
  reviewedWeeks: string[];
  /** Special-mode periods (UTC ms); a week that overlaps one is neutral for the streak. */
  specialPeriods?: { periodId: string; fromMs: number; toMs: number }[];
}

export interface SupervisionStore {
  get(userId: string): SupervisionRecord | undefined;
  set(userId: string, record: SupervisionRecord): void;
}

export function createMemorySupervisionStore(): SupervisionStore {
  const records = new Map<string, SupervisionRecord>();
  return {
    get: (userId) => records.get(userId),
    set: (userId, record) => void records.set(userId, record),
  };
}

function envelope(
  now: Date,
  id: string,
  type: string,
  userId: string,
  payload: unknown,
): EventEnvelope {
  return {
    id,
    type,
    occurredAt: now.toISOString(),
    userId,
    schemaVersion: 1,
    payload,
  } as EventEnvelope;
}

async function readLevel(deps: MonitorDeps, userId: string): Promise<SupervisionLevel> {
  const answer = (await deps.readSettings(userId))["monitor.supervision_level"];
  const parsed = SETTINGS["monitor.supervision_level"].schema.safeParse(answer);
  return parsed.success ? parsed.data : SETTINGS["monitor.supervision_level"].default;
}

async function readCleanWeeks(deps: MonitorDeps, userId: string): Promise<number> {
  const answer = (await deps.readSettings(userId))["monitor.taper_clean_weeks"];
  return typeof answer === "number" && Number.isInteger(answer) && answer > 0
    ? answer
    : SETTINGS["monitor.taper_clean_weeks"].default;
}

/**
 * A week is clean when it holds no hard fault of the user: a reason ticket that ended `answered`
 * or `expired` and was not waived for an outage. Open tickets are not facts yet.
 */
function isCleanWeek(deps: MonitorDeps, userId: string, startMs: number, endMs: number): boolean {
  const waived = new Set(deps.state.waivers.all().map((w) => w.signalRef));
  return !deps.state.tickets.all().some((t) => {
    if (t.userId !== userId || (t.state !== "answered" && t.state !== "expired")) return false;
    const at = Date.parse(t.occurredAt);
    return at >= startMs && at < endMs && !waived.has(t.signalRef);
  });
}

/**
 * Weekly review (`week.closed`): counts the week toward the clean streak and, once the streak
 * reaches `monitor.taper_clean_weeks`, asks `ask.supervision_taper`. The level never changes here;
 * only the user's confirmation changes it. Redelivery of the same week is a no-op, and the week
 * is recorded only after the question went out, so a failed publish is retried by the next delivery.
 */
export async function reviewWeek(deps: MonitorDeps, event: EventEnvelope): Promise<void> {
  if (event.type !== "week.closed") return;
  const { weekId, firstDay } = (event as EventEnvelope<"week.closed">).payload;
  const userId = event.userId;
  const stored = deps.state.supervision.get(userId);
  if (stored?.reviewedWeeks.includes(weekId)) return;
  const record: SupervisionRecord = {
    level: stored?.level ?? (await readLevel(deps, userId)),
    cleanWeeks: stored?.cleanWeeks ?? 0,
    pending: stored?.pending ?? null,
    reviewedWeeks: [...(stored?.reviewedWeeks ?? []), weekId],
    specialPeriods: stored?.specialPeriods ?? [],
  };
  const startMs = Date.parse(`${firstDay}T00:00:00.000Z`);
  const endMs = startMs + WEEK_DAYS * DAY_MS;
  // A week with a special-mode day is neutral: neither clean nor not clean.
  const neutral = (record.specialPeriods ?? []).some((p) => p.fromMs < endMs && p.toMs > startMs);
  if (!neutral) {
    record.cleanWeeks = isCleanWeek(deps, userId, startMs, endMs) ? record.cleanWeeks + 1 : 0;
  }

  const next = record.level ? NEXT_LEVEL[record.level] : null;
  if (
    record.level &&
    next &&
    !record.pending &&
    record.cleanWeeks >= (await readCleanWeeks(deps, userId))
  ) {
    const questionId = `taper-${userId}-${weekId}`;
    const question: TaperQuestion = {
      questionId,
      from: record.level,
      to: next,
      effectiveFrom: new Date(endMs).toISOString(),
    };
    await deps.publish(
      envelope(deps.now(), `ask-supervision-taper-${weekId}`, "ask.supervision_taper", userId, {
        questionId,
        kind: ASK_KIND,
        subjectRef: `supervision:${userId}`,
        options: [
          { value: "accept", labelKey: "monitor.taper.accept" },
          { value: "decline", labelKey: "monitor.taper.decline" },
        ],
        expiresAt: new Date(endMs + WEEK_DAYS * DAY_MS).toISOString(),
        params: { from: record.level, to: next, weeks: record.cleanWeeks },
      }),
    );
    record.pending = question;
  }
  deps.state.supervision.set(userId, record);
}

/** The user's answer (`notify.reply_received`) or an expired question (`notify.question_expired`). */
export async function answerTaper(deps: MonitorDeps, event: EventEnvelope): Promise<void> {
  const userId = event.userId;
  const record = deps.state.supervision.get(userId);
  const pending = record?.pending;
  if (!record || !pending) return;
  if (event.type === "notify.question_expired") {
    const { questionId, sourceService, kind } = (event as EventEnvelope<"notify.question_expired">)
      .payload;
    if (
      sourceService === SOURCE_SERVICE &&
      kind === ASK_KIND &&
      questionId === pending.questionId
    ) {
      // An unanswered ask counts as a refusal: snooze, so another full streak is needed.
      deps.state.supervision.set(userId, { ...record, pending: null, cleanWeeks: 0 });
    }
    return;
  }
  if (event.type !== "notify.reply_received") return;
  const { questionId, sourceService, kind, value } = (
    event as EventEnvelope<"notify.reply_received">
  ).payload;
  if (sourceService !== SOURCE_SERVICE || kind !== ASK_KIND || questionId !== pending.questionId)
    return;

  if (value === "accept") {
    // Announce first, then commit: a failed publish leaves the question open for a retry.
    const effectiveFrom = new Date(
      Math.max(Date.parse(pending.effectiveFrom), deps.now().getTime()),
    );
    await deps.publish(
      envelope(
        deps.now(),
        `supervision-level-changed-${questionId}`,
        "supervision.level_changed",
        userId,
        {
          from: pending.from,
          to: pending.to,
          cause: "taper_accepted",
          effectiveFrom: effectiveFrom.toISOString(),
        },
      ),
    );
    deps.state.supervision.set(userId, {
      ...record,
      level: pending.to,
      cleanWeeks: 0,
      pending: null,
    });
  } else if (value === "decline") {
    // Snooze: the streak restarts, so `monitor.taper_clean_weeks` more clean weeks are needed.
    deps.state.supervision.set(userId, { ...record, pending: null, cleanWeeks: 0 });
  }
}

/** Records special-mode periods (`special_mode.started` / `special_mode.ended`) for the review. */
export async function trackSpecialMode(deps: MonitorDeps, event: EventEnvelope): Promise<void> {
  const userId = event.userId;
  const stored = deps.state.supervision.get(userId);
  const record: SupervisionRecord = stored ?? {
    level: null,
    cleanWeeks: 0,
    pending: null,
    reviewedWeeks: [],
  };
  const periods = [...(record.specialPeriods ?? [])];
  if (event.type === "special_mode.started") {
    const p = (event as EventEnvelope<"special_mode.started">).payload;
    if (!periods.some((x) => x.periodId === p.periodId)) {
      periods.push({ periodId: p.periodId, fromMs: Date.parse(p.from), toMs: Date.parse(p.to) });
    }
  } else if (event.type === "special_mode.ended") {
    const { periodId } = (event as EventEnvelope<"special_mode.ended">).payload;
    const end = Date.parse(event.occurredAt);
    for (const x of periods) if (x.periodId === periodId) x.toMs = Math.min(x.toMs, end);
  } else return;
  deps.state.supervision.set(userId, { ...record, specialPeriods: periods });
}
