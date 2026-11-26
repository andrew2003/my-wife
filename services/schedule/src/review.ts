import { SETTINGS, type EventEnvelope } from "@my-wife/contracts";
import type { PlanDeps, PlanStore, PlanWeek } from "./plan";

const DAY_MS = 86_400_000;
const WEEK_DAYS = 7;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

interface FaultRow {
  userId: string;
  faultId: string;
  type: string;
  points: number;
  occurredAt: string;
  waived: boolean;
}
interface OverspendRow {
  userId: string;
  eventId: string;
  occurredAt: string;
  cycleId: string;
  weekIndex: number;
  categoryId: string;
  weeklyLimitVnd: number;
  spentVnd: number;
  excessVnd: number;
}

/** Port: copies of the rules and budget ledgers that the review is built from. */
export interface LedgerStore {
  addFault(row: FaultRow): void;
  waiveFault(userId: string, faultId: string): void;
  addOverspend(row: OverspendRow): void;
  faults(userId: string): FaultRow[];
  overspends(userId: string): OverspendRow[];
}

export function createMemoryLedgerStore(): LedgerStore {
  const faults = new Map<string, FaultRow>();
  const waivedEarly = new Set<string>();
  const spends = new Map<string, OverspendRow>();
  const key = (userId: string, id: string) => `${userId}:${id}`;
  return {
    addFault: (r) => {
      const k = key(r.userId, r.faultId);
      if (!faults.has(k)) faults.set(k, { ...r, waived: r.waived || waivedEarly.has(k) });
    },
    waiveFault: (userId, faultId) => {
      const k = key(userId, faultId);
      const row = faults.get(k);
      if (row) row.waived = true;
      else waivedEarly.add(k);
    },
    addOverspend: (r) => {
      const k = key(r.userId, r.eventId);
      if (!spends.has(k)) spends.set(k, r);
    },
    faults: (userId) => [...faults.values()].filter((r) => r.userId === userId),
    overspends: (userId) => [...spends.values()].filter((r) => r.userId === userId),
  };
}

/** Stores the ledger events the review needs; returns whether the event was one of them. */
export function recordLedgerEvent(store: LedgerStore, event: EventEnvelope): boolean {
  switch (event.type) {
    case "fault.recorded": {
      const p = (event as EventEnvelope<"fault.recorded">).payload;
      store.addFault({
        userId: event.userId,
        faultId: p.faultId,
        type: p.type,
        points: p.points,
        occurredAt: p.occurredAt,
        waived: false,
      });
      return true;
    }
    case "fault.waived":
      store.waiveFault(event.userId, (event as EventEnvelope<"fault.waived">).payload.faultId);
      return true;
    case "overspend.detected": {
      const p = (event as EventEnvelope<"overspend.detected">).payload;
      store.addOverspend({
        userId: event.userId,
        eventId: event.id,
        occurredAt: event.occurredAt,
        cycleId: p.cycleId,
        weekIndex: p.weekIndex,
        categoryId: p.categoryId,
        weeklyLimitVnd: p.weeklyLimitVnd,
        spentVnd: p.spentVnd,
        excessVnd: p.excessVnd,
      });
      return true;
    }
    default:
      return false;
  }
}

const weekStart = (w: PlanWeek) => Date.parse(`${w.firstDay}T00:00:00Z`);
const weekEnd = (w: PlanWeek) => weekStart(w) + WEEK_DAYS * DAY_MS;

function reviewSetting(raw: unknown): { weekday: string; time: string } {
  const def = SETTINGS["schedule.weekly_review_time"].default as { weekday: string; time: string };
  const v = raw as { weekday?: unknown; time?: unknown } | undefined;
  const weekday =
    typeof v?.weekday === "string" && WEEKDAYS.includes(v.weekday) ? v.weekday : def.weekday;
  const time =
    typeof v?.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v.time) ? v.time : def.time;
  return { weekday, time };
}

/** First occurrence of the user's review weekday and time at or after the end of the week (UTC). */
export function reviewDueAt(week: PlanWeek, raw: unknown): Date {
  const { weekday, time } = reviewSetting(raw);
  const [h, m] = time.split(":").map(Number) as [number, number];
  const end = weekEnd(week);
  const endDay = new Date(end);
  for (let i = 0; i <= WEEK_DAYS; i++) {
    const day = new Date(end + i * DAY_MS);
    if (WEEKDAYS[day.getUTCDay()] !== weekday) continue;
    const at = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, m);
    if (at >= end) return new Date(at);
  }
  return endDay; // unreachable: every weekday occurs within 8 days
}

/**
 * Announces `review.ready` once per week. Only weeks whose `week.closed` was already announced
 * qualify, so the review can never come first; a failed publish is retried by the next run.
 */
export async function runReviewJob(
  deps: PlanDeps,
  readSettings: (userId: string) => Promise<Record<string, unknown>>,
): Promise<{ ready: string[]; failed: string[] }> {
  const result = { ready: [] as string[], failed: [] as string[] };
  const nowMs = deps.now().getTime();
  for (const week of deps.store.allWeeks()) {
    if (!week.closedAnnounced || week.reviewAnnounced) continue;
    const settings = await readSettings(week.userId).catch((): Record<string, unknown> => ({}));
    if (nowMs < reviewDueAt(week, settings["schedule.weekly_review_time"]).getTime()) continue;
    if (week.reviewAnnounced) continue; // claimed while the settings were being read
    week.reviewAnnounced = true;
    try {
      await deps.publish({
        id: `review-ready-${week.id}`,
        type: "review.ready",
        occurredAt: deps.now().toISOString(),
        userId: week.userId,
        schemaVersion: 1,
        payload: { weekId: week.id, firstDay: week.firstDay },
      } as EventEnvelope);
      result.ready.push(week.id);
    } catch {
      week.reviewAnnounced = false;
      result.failed.push(week.id);
    }
  }
  return result;
}

/**
 * Overspend events carry no week reference, so each belongs to the latest week of the user that
 * had ended before the event was announced (budget emits them right after `week.closed`).
 */
function overspendWeekId(store: PlanStore, row: OverspendRow): string | undefined {
  const at = Date.parse(row.occurredAt);
  return store
    .allWeeks()
    .filter((w) => w.userId === row.userId && weekEnd(w) <= at)
    .sort((a, b) => b.firstDay.localeCompare(a.firstDay))[0]?.id;
}

/** Every number is computed from the stored plan and ledgers; nothing is an LLM figure. */
export function buildReview(store: PlanStore, ledgers: LedgerStore, week: PlanWeek) {
  const days = new Set(
    Array.from({ length: WEEK_DAYS }, (_, i) =>
      new Date(weekStart(week) + i * DAY_MS).toISOString().slice(0, 10),
    ),
  );
  const tasks = days.size
    ? [...days].flatMap((d) => store.tasksOn(week.userId, d)).filter((t) => t.state !== "cancelled")
    : [];
  const completed = tasks.filter((t) => t.state === "done");
  const faults = ledgers
    .faults(week.userId)
    .filter((f) => !f.waived && days.has(new Date(f.occurredAt).toISOString().slice(0, 10)));
  const spending = ledgers
    .overspends(week.userId)
    .filter((o) => overspendWeekId(store, o) === week.id);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  return {
    weekId: week.id,
    firstDay: week.firstDay,
    tasks: {
      planned: tasks.length,
      completed: completed.length,
      carried: tasks.filter((t) => t.state === "carried").length,
      open: tasks.filter((t) => t.state === "planned" || t.state === "in_progress").length,
      completedTasks: completed.map((t) => ({ id: t.id, title: t.title, day: t.day })),
    },
    faults: {
      totalPoints: sum(faults.map((f) => f.points)),
      items: faults.map(({ userId: _u, waived: _w, ...f }) => f),
    },
    spending: {
      spentVnd: sum(spending.map((o) => o.spentVnd)),
      excessVnd: sum(spending.map((o) => o.excessVnd)),
      items: spending.map(({ userId: _u, eventId: _e, ...o }) => o),
    },
  };
}
