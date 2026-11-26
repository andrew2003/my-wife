import { SETTINGS } from "@my-wife/contracts";

export const MINUTE_MS = 60_000;
export const DAY_MS = 24 * 60 * MINUTE_MS;
export const WEEK_MS = 7 * DAY_MS;

/** Business code takes time through this interface so tests can simulate it (ADR 0008). */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export type TimerId = number;
type Job = () => void | Promise<void>;

interface Timer {
  id: TimerId;
  seq: number;
  dueMs: number;
  job: Job;
  everyMs: number | null;
}

/**
 * Deterministic clock with a timer queue. Time only moves when a test advances it, and every
 * timer that falls inside the advanced window fires in (due time, insertion order) with
 * `now()` set to its due time.
 */
export class SimClock implements Clock {
  private nowMs: number;
  private seq = 0;
  private nextId = 1;
  private timers = new Map<TimerId, Timer>();

  /** `cycleWeeks` defaults to the registry default of `budget.cycle_weeks`. */
  constructor(
    start: Date | string,
    private readonly cycleWeeks: number = SETTINGS["budget.cycle_weeks"].default,
  ) {
    this.nowMs = new Date(start).getTime();
    if (Number.isNaN(this.nowMs)) throw new Error("Invalid start time");
  }

  now(): Date {
    return new Date(this.nowMs);
  }

  pending(): number {
    return this.timers.size;
  }

  schedule(at: Date | string, job: Job): TimerId {
    return this.add(new Date(at).getTime(), job, null);
  }

  scheduleIn(delayMs: number, job: Job): TimerId {
    return this.add(this.nowMs + delayMs, job, null);
  }

  /** Repeating job; the first run is one interval from now. */
  scheduleEvery(intervalMs: number, job: Job): TimerId {
    if (!(intervalMs > 0)) throw new Error("Interval must be positive");
    return this.add(this.nowMs + intervalMs, job, intervalMs);
  }

  cancel(id: TimerId): void {
    this.timers.delete(id);
  }

  /** Moves to `target`, firing due timers on the way. Returns the number of jobs fired. */
  async advanceTo(target: Date | string): Promise<number> {
    const targetMs = new Date(target).getTime();
    if (targetMs < this.nowMs) throw new Error("Cannot move the clock backwards");
    let fired = 0;
    for (;;) {
      const next = this.nextDue(targetMs);
      if (!next) break;
      this.nowMs = Math.max(this.nowMs, next.dueMs);
      if (next.everyMs === null) this.timers.delete(next.id);
      else {
        next.dueMs += next.everyMs;
        next.seq = this.seq++;
      }
      await next.job();
      fired++;
    }
    this.nowMs = targetMs;
    return fired;
  }

  advanceBy(ms: number): Promise<number> {
    return this.advanceTo(new Date(this.nowMs + ms));
  }
  advanceDays(days: number): Promise<number> {
    return this.advanceBy(days * DAY_MS);
  }
  advanceWeeks(weeks: number): Promise<number> {
    return this.advanceBy(weeks * WEEK_MS);
  }
  advanceCycles(cycles: number, cycleWeeks: number = this.cycleWeeks): Promise<number> {
    return this.advanceWeeks(cycles * cycleWeeks);
  }

  private add(dueMs: number, job: Job, everyMs: number | null): TimerId {
    const id = this.nextId++;
    this.timers.set(id, { id, seq: this.seq++, dueMs, job, everyMs });
    return id;
  }

  private nextDue(limitMs: number): Timer | undefined {
    let best: Timer | undefined;
    for (const t of this.timers.values()) {
      if (t.dueMs > limitMs) continue;
      if (!best || t.dueMs < best.dueMs || (t.dueMs === best.dueMs && t.seq < best.seq)) best = t;
    }
    return best;
  }
}
