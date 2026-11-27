import type { EventEnvelope } from "@my-wife/contracts";
import { RoutineLevelSchema, SETTINGS, type SleepNightStateSchema } from "@my-wife/contracts";
import type { PlanDeps } from "./plan";
import { wakeTimeOf } from "./routine-blocks";
import { zoneParts, zoneSetting, zonedInstant } from "./review";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** A night first seen later than this after bedtime is ignored; the next night takes over. */
const NIGHT_SPAN_MS = 12 * 60 * MINUTE_MS;

export type SleepNightState = ReturnType<typeof SleepNightStateSchema.parse>;

/** One night of the `sleep_night` state machine (spec 22 section 3), keyed by the bedtime date. */
export interface SleepNight {
  userId: string;
  /** Local date (user's time zone) on which the bedtime falls. */
  nightDate: string;
  state: SleepNightState;
  /** UTC ISO time of the bedtime. */
  bedtimeAt: string;
  /** Set once the reminder was announced. */
  remindedAt: string | null;
  /** UTC ISO time of the first web activity after bedtime, when the soft `late_night` label was set. */
  lateNightLabelledAt?: string | null;
}

/** Port: the Drizzle store replaces the in-memory one without touching the logic below. */
export interface SleepStore {
  get(userId: string, nightDate: string): SleepNight | undefined;
  put(night: SleepNight): void;
}

export function createMemorySleepStore(): SleepStore {
  const nights = new Map<string, SleepNight>();
  const key = (u: string, d: string) => `${u}|${d}`;
  return {
    get: (u, d) => nights.get(key(u, d)),
    put: (n) => void nights.set(key(n.userId, n.nightDate), n),
  };
}

export interface SleepDeps {
  plan: PlanDeps;
  store: SleepStore;
  readSettings: (userId: string) => Promise<Record<string, unknown>>;
}

interface SleepSettings {
  active: boolean;
  hour: number;
  minute: number;
  leadMinutes: number;
  zone: string;
}

/** Invalid or missing values fall back to the registry defaults. */
function sleepSettings(raw: Record<string, unknown>): SleepSettings {
  const level = RoutineLevelSchema.safeParse(raw["routine.sleep.level"]);
  const levelValue = level.success ? level.data : SETTINGS["routine.sleep.level"].default;
  const start = raw["routine.sleep.start"];
  const startValue =
    typeof start === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(start)
      ? start
      : (SETTINGS["routine.sleep.start"].default as string);
  const lead = raw["routine.bedtime_lead_minutes"];
  const leadValue =
    typeof lead === "number" && Number.isInteger(lead) && lead > 0
      ? lead
      : (SETTINGS["routine.bedtime_lead_minutes"].default as number);
  const [hour, minute] = startValue.split(":").map(Number) as [number, number];
  return {
    active: levelValue !== "off",
    hour,
    minute,
    leadMinutes: leadValue,
    zone: zoneSetting(raw["calendar.time_zone"]),
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Moves the nights of one user forward at `now`. Idle goes to `winddown` and on to
 * `bedtime_reminded` once the lead time before bedtime is reached (announcing the reminder);
 * `bedtime_reminded` goes to `sleeping` at bedtime. The state is saved only after the
 * announcement succeeds, so a failed publish is retried by the next run.
 */
export async function runSleepForUser(deps: SleepDeps, userId: string, now: Date): Promise<void> {
  const s = sleepSettings(await deps.readSettings(userId));
  if (!s.active) return;
  const nowMs = now.getTime();
  const today = zoneParts(nowMs, s.zone);
  // Bedtimes of yesterday, today and tomorrow cover a bedtime after local midnight.
  for (const offset of [-1, 0, 1]) {
    const day = new Date(Date.UTC(today.y, today.mo - 1, today.d) + offset * DAY_MS);
    const y = day.getUTCFullYear();
    const mo = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    const nightDate = `${y}-${pad(mo)}-${pad(d)}`;
    const bedtimeMs = zonedInstant(y, mo, d, s.hour, s.minute, s.zone);
    const reminderMs = bedtimeMs - s.leadMinutes * MINUTE_MS;
    if (nowMs < reminderMs || nowMs >= bedtimeMs + NIGHT_SPAN_MS) continue;

    const night: SleepNight = deps.store.get(userId, nightDate) ?? {
      userId,
      nightDate,
      state: "idle",
      bedtimeAt: new Date(bedtimeMs).toISOString(),
      remindedAt: null,
    };
    if (night.state === "idle" || night.state === "winddown") {
      // Reached the lead time: remind, unless bedtime has already passed (nothing to prepare).
      if (nowMs < bedtimeMs) {
        await deps.plan.publish(reminderEvent(deps.plan, night, reminderMs, s.leadMinutes, s));
        night.state = "bedtime_reminded";
        night.remindedAt = now.toISOString();
      } else {
        night.state = "sleeping";
      }
    }
    if (night.state === "bedtime_reminded" && nowMs >= bedtimeMs) night.state = "sleeping";
    deps.store.put(night);
  }
}

function reminderEvent(
  plan: PlanDeps,
  night: SleepNight,
  dueMs: number,
  leadMinutes: number,
  s: SleepSettings,
): EventEnvelope {
  return {
    id: `routine-bedtime-reminder-${night.userId}-${night.nightDate}`,
    type: "routine.reminder_due",
    occurredAt: plan.now().toISOString(),
    userId: night.userId,
    schemaVersion: 1,
    payload: {
      routine: "sleep",
      dueAt: new Date(dueMs).toISOString(),
      messageKey: "routine.bedtime_reminder",
      params: { minutes: leadMinutes, bedtime: `${pad(s.hour)}:${pad(s.minute)}` },
    },
  } as EventEnvelope;
}

/** Quick reasons offered with the late-night label (locale keys `routine.late_night.reason.<id>`). */
export const LATE_NIGHT_QUICK_REASONS = ["urgent_work", "cannot_sleep"] as const;

export interface LateNightResult {
  labelled: boolean;
  label: "late_night" | null;
  quickReasons: readonly string[];
}

/**
 * Web activity at `at` (spec 22 section 3, `sleeping` row). After bedtime the night gets the soft
 * `late_night` label and one reminder, however often activity repeats. It is informational: no
 * fault event is ever emitted from here. `at` is a parameter; the system clock is not read.
 */
export async function recordWebActivity(
  deps: SleepDeps,
  userId: string,
  at: Date,
): Promise<LateNightResult> {
  const none: LateNightResult = { labelled: false, label: null, quickReasons: [] };
  const raw = await deps.readSettings(userId);
  const s = sleepSettings(raw);
  if (!s.active) return none;
  // Bring the machine up to `at` first, so activity right after bedtime is not missed.
  await runSleepForUser(deps, userId, at);
  const atMs = at.getTime();
  const today = zoneParts(atMs, s.zone);
  for (const offset of [-1, 0, 1]) {
    const day = new Date(Date.UTC(today.y, today.mo - 1, today.d) + offset * DAY_MS);
    const nightDate = `${day.getUTCFullYear()}-${pad(day.getUTCMonth() + 1)}-${pad(day.getUTCDate())}`;
    const night = deps.store.get(userId, nightDate);
    if (!night || night.state !== "sleeping") continue;
    const bedtimeMs = new Date(night.bedtimeAt).getTime();
    if (atMs < bedtimeMs || atMs >= Math.min(wakeAfter(raw, night, s), bedtimeMs + NIGHT_SPAN_MS)) {
      continue;
    }
    if (!night.lateNightLabelledAt) {
      await deps.plan.publish(lateNightReminderEvent(deps.plan, night, at));
      night.lateNightLabelledAt = at.toISOString();
      deps.store.put(night);
    }
    return { labelled: true, label: "late_night", quickReasons: LATE_NIGHT_QUICK_REASONS };
  }
  return none;
}

/** First wake time (UTC ms) after the bedtime of `night`; the weekend profile applies to the wake day. */
function wakeAfter(raw: Record<string, unknown>, night: SleepNight, s: SleepSettings): number {
  const bedtimeMs = new Date(night.bedtimeAt).getTime();
  const [y, mo, d] = night.nightDate.split("-").map(Number) as [number, number, number];
  for (const offset of [0, 1]) {
    const day = new Date(Date.UTC(y, mo - 1, d) + offset * DAY_MS);
    const isoDay = `${day.getUTCFullYear()}-${pad(day.getUTCMonth() + 1)}-${pad(day.getUTCDate())}`;
    const [h, m] = wakeTimeOf(raw, isoDay).split(":").map(Number) as [number, number];
    const wakeMs = zonedInstant(
      day.getUTCFullYear(),
      day.getUTCMonth() + 1,
      day.getUTCDate(),
      h,
      m,
      s.zone,
    );
    if (wakeMs > bedtimeMs) return wakeMs;
  }
  return bedtimeMs + NIGHT_SPAN_MS;
}

function lateNightReminderEvent(plan: PlanDeps, night: SleepNight, at: Date): EventEnvelope {
  return {
    id: `routine-late-night-${night.userId}-${night.nightDate}`,
    type: "routine.reminder_due",
    occurredAt: plan.now().toISOString(),
    userId: night.userId,
    schemaVersion: 1,
    payload: {
      routine: "sleep",
      dueAt: at.toISOString(),
      messageKey: "routine.late_night_reminder",
      params: {},
    },
  } as EventEnvelope;
}

/**
 * Idempotent job over every user with a plan. `now` is a parameter; this code never reads the
 * system clock. A user whose settings or publish fail is reported and retried next run.
 */
export async function runSleepJob(
  deps: SleepDeps,
  now: Date,
): Promise<{ checked: number; failed: string[] }> {
  const users = [...new Set(deps.plan.store.allWeeks().map((w) => w.userId))];
  const failed: string[] = [];
  for (const userId of users) {
    try {
      await runSleepForUser(deps, userId, now);
    } catch {
      failed.push(userId);
    }
  }
  return { checked: users.length, failed };
}
