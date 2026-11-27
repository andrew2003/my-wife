import { randomUUID } from "node:crypto";
import {
  EVENT_SCHEMA_VERSION,
  SETTINGS,
  type EventEnvelope,
  type EventPayload,
  type SettingKey,
} from "@my-wife/contracts";

export type RuleChangeDirection = "tightening" | "loosening";
export type EffectiveScope = "next_week" | "next_cycle";
type Weekday = (typeof SETTINGS)["calendar.week_start_day"]["default"];

/**
 * How a setting makes the commitment looser. A key that is not listed is not a commitment
 * rule, so changing it is never locked.
 *  - lower: a lower value is looser (lower penalty, smaller weight).
 *  - higher: a higher value is looser (more waivers).
 *  - ordered: a value earlier in the list is looser.
 */
type LooseningRule =
  | { kind: "lower" }
  | { kind: "higher" }
  | { kind: "ordered"; looserFirst: readonly string[] }
  | { kind: "thresholds" };

const ROUTINE_LEVELS = ["off", "remind", "track", "commit"] as const;
const LOOSENING_RULES: Record<string, LooseningRule> = {
  "penalty.overspend_percent": { kind: "lower" },
  "penalty.weekly_cap_vnd": { kind: "lower" },
  "penalty.withdrawal_extra_percent": { kind: "lower" },
  "penalty.need_overspend_mode": { kind: "ordered", looserFirst: ["warn_only", "penalize"] },
  "fault.reason_multiplier_percent.honest": { kind: "lower" },
  "fault.reason_multiplier_percent.silent": { kind: "lower" },
  "fault.waivers_per_week": { kind: "higher" },
  "fault.thresholds": { kind: "thresholds" },
  "monitor.supervision_level": {
    kind: "ordered",
    looserFirst: ["checklist_only", "no_camera", "graduated", "full"],
  },
  "routine.sleep.level": { kind: "ordered", looserFirst: ROUTINE_LEVELS },
  "routine.meals.level": { kind: "ordered", looserFirst: ROUTINE_LEVELS },
  "routine.wake.level": { kind: "ordered", looserFirst: ROUTINE_LEVELS },
};
for (const key of Object.keys(SETTINGS)) {
  if (key.startsWith("fault.weight.")) LOOSENING_RULES[key] = { kind: "lower" };
}

type Threshold = { points: number; amountVnd: number };
const isThresholdList = (v: unknown): v is Threshold[] =>
  Array.isArray(v) &&
  v.every(
    (t) =>
      typeof t === "object" &&
      t !== null &&
      typeof (t as Threshold).points === "number" &&
      typeof (t as Threshold).amountVnd === "number",
  );

/**
 * A threshold list is looser when some penalty it used to give is now smaller or starts
 * at more points, including a tier that was removed. Mixed changes count as loosening.
 */
function thresholdsLoosened(from: Threshold[], to: Threshold[]): boolean {
  const penaltyAt = (list: Threshold[], points: number) =>
    list.filter((t) => t.points <= points).reduce((max, t) => Math.max(max, t.amountVnd), 0);
  const checkpoints = [...from, ...to].map((t) => t.points);
  return checkpoints.some((p) => penaltyAt(to, p) < penaltyAt(from, p));
}

/** The single decision function: true when the change makes the user's commitment weaker. */
export function isLooseningChange(key: string, from: unknown, to: unknown): boolean {
  const rule = LOOSENING_RULES[key];
  if (!rule) return false;
  switch (rule.kind) {
    case "lower":
      return typeof from === "number" && typeof to === "number" && to < from;
    case "higher":
      return typeof from === "number" && typeof to === "number" && to > from;
    case "ordered": {
      const a = rule.looserFirst.indexOf(String(from));
      const b = rule.looserFirst.indexOf(String(to));
      return a >= 0 && b >= 0 && b < a;
    }
    case "thresholds":
      return isThresholdList(from) && isThresholdList(to) && thresholdsLoosened(from, to);
  }
}

export function classifyRuleChange(key: string, from: unknown, to: unknown): RuleChangeDirection {
  return isLooseningChange(key, from, to) ? "loosening" : "tightening";
}

const WEEKDAYS: readonly Weekday[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

function localParts(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    weekday: "long",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: WEEKDAYS.indexOf(get("weekday").toLowerCase() as Weekday),
  };
}

function offsetMs(at: Date, timeZone: string): number {
  const p = localParts(at, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** Start of the next local week (local midnight of the week start day, strictly after now). */
function nextWeekStart(now: Date, timeZone: string, weekStartDay: Weekday): Date {
  const p = localParts(now, timeZone);
  const days = (WEEKDAYS.indexOf(weekStartDay) - p.weekday + 7) % 7 || 7;
  const localMidnightAsUtc = Date.UTC(p.year, p.month - 1, p.day + days);
  const guess = new Date(localMidnightAsUtc - offsetMs(now, timeZone));
  return new Date(localMidnightAsUtc - offsetMs(guess, timeZone));
}

export type EffectiveFromInput = {
  direction: RuleChangeDirection;
  /** From `loosening.effective_from`. */
  scope: EffectiveScope;
  timeZone: string;
  weekStartDay: Weekday;
  /** Start of the next cycle; used when scope is `next_cycle`. */
  nextCycleStartsAt?: string;
};

/** Tightening is effective at `now`; loosening waits for the next week (or cycle) start. */
export function computeEffectiveFrom(input: EffectiveFromInput, now: Date): Date {
  if (input.direction === "tightening") return now;
  if (input.scope === "next_cycle" && input.nextCycleStartsAt) {
    const cycle = new Date(input.nextCycleStartsAt);
    if (cycle.getTime() > now.getTime()) return cycle;
  }
  return nextWeekStart(now, input.timeZone, input.weekStartDay);
}

export type RuleChangeRecord = {
  id: string;
  userId: string;
  key: string;
  from: unknown;
  to: unknown;
  direction: RuleChangeDirection;
  changedAt: string;
  effectiveFrom: string;
};

export interface RuleChangeStore {
  save(record: RuleChangeRecord): void;
  list(userId: string): RuleChangeRecord[];
}

export class InMemoryRuleChangeStore implements RuleChangeStore {
  private readonly rows: RuleChangeRecord[] = [];
  save(record: RuleChangeRecord) {
    this.rows.push(Object.freeze({ ...record }));
  }
  list(userId: string) {
    return this.rows.filter((r) => r.userId === userId);
  }
}

export type RuleChangeServiceDeps = {
  store: RuleChangeStore;
  publish?: (event: EventEnvelope) => void | Promise<void>;
  /** The user's settings by key; missing or invalid values fall back to registry defaults. */
  readSettings: (userId: string) => Record<string, unknown>;
  newId?: () => string;
  nextCycleStartsAt?: (userId: string, now: Date) => string | undefined;
};

function setting<K extends SettingKey>(values: Record<string, unknown>, key: K) {
  const parsed = SETTINGS[key].schema.safeParse(values[key]);
  return (parsed.success ? parsed.data : SETTINGS[key].default) as (typeof SETTINGS)[K]["default"];
}

export function createRuleChangeService(deps: RuleChangeServiceDeps) {
  const newId = deps.newId ?? randomUUID;
  return {
    /** Records a rule change with its effective date and publishes `rule.changed`. */
    async save(userId: string, change: { key: string; from: unknown; to: unknown }, now: Date) {
      const values = deps.readSettings(userId);
      const direction = classifyRuleChange(change.key, change.from, change.to);
      const effectiveFrom = computeEffectiveFrom(
        {
          direction,
          scope: setting(values, "loosening.effective_from"),
          timeZone: setting(values, "calendar.time_zone"),
          weekStartDay: setting(values, "calendar.week_start_day"),
          nextCycleStartsAt: deps.nextCycleStartsAt?.(userId, now),
        },
        now,
      ).toISOString();
      const record: RuleChangeRecord = {
        id: newId(),
        userId,
        key: change.key,
        from: change.from,
        to: change.to,
        direction,
        changedAt: now.toISOString(),
        effectiveFrom,
      };
      deps.store.save(record);
      const payload: EventPayload<"rule.changed"> = { key: change.key, direction, effectiveFrom };
      await deps.publish?.({
        id: record.id,
        type: "rule.changed",
        userId,
        occurredAt: now.toISOString(),
        schemaVersion: EVENT_SCHEMA_VERSION,
        payload,
      } as EventEnvelope);
      return record;
    },
  };
}
