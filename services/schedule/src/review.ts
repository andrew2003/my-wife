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

interface TxnRow {
  userId: string;
  transactionId: string;
  occurredAt: string;
  amountVnd: number;
}

/** Port: copies of the rules and budget ledgers that the review is built from. */
export interface LedgerStore {
  addFault(row: FaultRow): void;
  waiveFault(userId: string, faultId: string): void;
  addOverspend(row: OverspendRow): void;
  addTxn(row: TxnRow): void;
  setCycleFirstDay(userId: string, cycleId: string, firstDay: string): void;
  cycleFirstDay(userId: string, cycleId: string): string | undefined;
  cycleFirstDays(userId: string): string[];
  txns(userId: string): TxnRow[];
  faults(userId: string): FaultRow[];
  overspends(userId: string): OverspendRow[];
}

export function createMemoryLedgerStore(): LedgerStore {
  const faults = new Map<string, FaultRow>();
  const waivedEarly = new Set<string>();
  const spends = new Map<string, OverspendRow>();
  const txns = new Map<string, TxnRow>();
  const cycles = new Map<string, string>();
  const cyclesOfUser = new Map<string, Map<string, string>>();
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
    addTxn: (r) => {
      const k = key(r.userId, r.transactionId);
      if (!txns.has(k)) txns.set(k, r);
    },
    setCycleFirstDay: (userId, cycleId, firstDay) => {
      cycles.set(key(userId, cycleId), firstDay);
      const own = cyclesOfUser.get(userId) ?? new Map<string, string>();
      own.set(cycleId, firstDay);
      cyclesOfUser.set(userId, own);
    },
    cycleFirstDay: (userId, cycleId) => cycles.get(key(userId, cycleId)),
    cycleFirstDays: (userId) => [...(cyclesOfUser.get(userId)?.values() ?? [])],
    txns: (userId) => [...txns.values()].filter((r) => r.userId === userId),
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
    case "cycle.opened": {
      const p = (event as EventEnvelope<"cycle.opened">).payload;
      store.setCycleFirstDay(event.userId, p.cycleId, p.firstDay);
      return true;
    }
    case "txn.recorded": {
      // Only categorised money that left an account counts as spending; adjustments are not applied yet.
      const p = (event as EventEnvelope<"txn.recorded">).payload;
      if (p.direction !== "out" || p.categoryId === null) return false;
      store.addTxn({
        userId: event.userId,
        transactionId: p.transactionId,
        occurredAt: event.occurredAt,
        amountVnd: p.amountVnd,
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

const zoneFormats = new Map<string, Intl.DateTimeFormat>();
export function zoneParts(at: number, zone: string) {
  let f = zoneFormats.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "long",
    });
    zoneFormats.set(zone, f);
  }
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(at))) o[p.type] = p.value;
  return {
    y: Number(o.year),
    mo: Number(o.month),
    d: Number(o.day),
    weekday: String(o.weekday).toLowerCase(),
  };
}

/** UTC instant of local wall time `h:m` on a local date of `zone` (fixed-offset search). */
export function zonedInstant(y: number, mo: number, d: number, h: number, m: number, zone: string) {
  const guess = Date.UTC(y, mo - 1, d, h, m);
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(new Date(guess));
  const o: Record<string, number> = {};
  for (const x of p) if (x.type !== "literal") o[x.type] = Number(x.value);
  const asLocal = Date.UTC(o.year!, o.month! - 1, o.day!, o.hour!, o.minute!);
  return guess - (asLocal - guess);
}

export function zoneSetting(raw: unknown): string {
  const def = SETTINGS["calendar.time_zone"].default as string;
  if (typeof raw !== "string") return def;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: raw });
    return raw;
  } catch {
    return def;
  }
}

/**
 * The review is generated when the week closes (spec 20 section 2). When the user's review
 * weekday is the local day the week closes, it waits for the review time of that day instead,
 * so a user who reviews on the closing day gets it at their chosen time; otherwise it is due at
 * the close. Evaluated in the user's time zone.
 */
export function reviewDueAt(week: PlanWeek, raw: unknown, zoneRaw?: unknown): Date {
  const { weekday, time } = reviewSetting(raw);
  const zone = zoneSetting(zoneRaw);
  const end = weekEnd(week);
  const local = zoneParts(end, zone);
  if (local.weekday !== weekday) return new Date(end);
  const [h, m] = time.split(":").map(Number) as [number, number];
  return new Date(Math.max(end, zonedInstant(local.y, local.mo, local.d, h, m, zone)));
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
    if (
      nowMs <
      reviewDueAt(
        week,
        settings["schedule.weekly_review_time"],
        settings["calendar.time_zone"],
      ).getTime()
    )
      continue;
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
 * An overspend names its cycle and the week index inside it. The cycle first day comes from
 * `cycle.opened`, so the week is the one starting `(weekIndex - 1)` weeks after it. Without that
 * event the overspend is not attributed (and does not show) until the cycle is known.
 */
function overspendFirstDay(ledgers: LedgerStore, row: OverspendRow): string | undefined {
  const first = ledgers.cycleFirstDay(row.userId, row.cycleId);
  if (!first) return undefined;
  const at = Date.parse(`${first}T00:00:00Z`) + (row.weekIndex - 1) * WEEK_DAYS * DAY_MS;
  return new Date(at).toISOString().slice(0, 10);
}

/** Every number is computed from the stored plan and ledgers; nothing is an LLM figure. */
export function buildReview(store: PlanStore, ledgers: LedgerStore, week: PlanWeek) {
  const days = new Set(
    Array.from({ length: WEEK_DAYS }, (_, i) =>
      new Date(weekStart(week) + i * DAY_MS).toISOString().slice(0, 10),
    ),
  );
  const tasks = [...days]
    .flatMap((d) => store.tasksOn(week.userId, d))
    .filter((t) => t.state !== "cancelled");
  const completed = tasks.filter((t) => t.state === "done");
  const faults = ledgers
    .faults(week.userId)
    .filter((f) => !f.waived && days.has(new Date(f.occurredAt).toISOString().slice(0, 10)));
  const overspent = ledgers
    .overspends(week.userId)
    .filter((o) => overspendFirstDay(ledgers, o) === week.firstDay);
  const outgoing = ledgers
    .txns(week.userId)
    .filter((t) => days.has(new Date(t.occurredAt).toISOString().slice(0, 10)));
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
      /** All outgoing money recorded in the week, whatever the category. */
      spentVnd: sum(outgoing.map((t) => t.amountVnd)),
      /** Only categories that went over their weekly limit. */
      overspentExcessVnd: sum(overspent.map((o) => o.excessVnd)),
      overspent: overspent.map(({ userId: _u, eventId: _e, occurredAt: _o, ...o }) => o),
    },
  };
}
