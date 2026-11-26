import { describe, expect, it } from "vitest";
import { SimClock, DAY_MS, WEEK_MS } from "../src/clock";

const START = "2026-11-02T00:00:00.000Z"; // a Monday

describe("SimClock time travel", () => {
  const cases: Array<[string, (c: SimClock) => Promise<unknown>, string]> = [
    ["advanceBy 90 minutes", (c) => c.advanceBy(90 * 60_000), "2026-11-02T01:30:00.000Z"],
    ["advanceDays 3", (c) => c.advanceDays(3), "2026-11-05T00:00:00.000Z"],
    ["advanceWeeks 2", (c) => c.advanceWeeks(2), "2026-11-16T00:00:00.000Z"],
    ["advanceCycles 1 (default 4 weeks)", (c) => c.advanceCycles(1), "2026-11-30T00:00:00.000Z"],
    ["advanceCycles 2 of 2-week cycles", (c) => c.advanceCycles(2, 2), "2026-11-30T00:00:00.000Z"],
    ["advanceTo absolute", (c) => c.advanceTo("2027-01-01T00:00:00.000Z"), "2027-01-01T00:00:00.000Z"],
  ];
  it.each(cases)("%s", async (_n, act, expected) => {
    const clock = new SimClock(START);
    await act(clock);
    expect(clock.now().toISOString()).toBe(expected);
  });

  it("refuses to go backwards", async () => {
    const clock = new SimClock(START);
    await expect(clock.advanceTo("2026-10-01T00:00:00.000Z")).rejects.toThrow(/backwards/);
  });

  it("returns a copy so callers cannot mutate the clock", () => {
    const clock = new SimClock(START);
    clock.now().setUTCFullYear(1999);
    expect(clock.now().toISOString()).toBe(START);
  });
});

describe("SimClock timers", () => {
  it("fires due timers in time order, then insertion order, with now() set to the due time", async () => {
    const clock = new SimClock(START);
    const log: string[] = [];
    const t = (label: string) => () => void log.push(`${label}@${clock.now().toISOString()}`);
    clock.schedule(new Date(Date.parse(START) + 2 * DAY_MS), t("b"));
    clock.schedule(new Date(Date.parse(START) + DAY_MS), t("a"));
    clock.schedule(new Date(Date.parse(START) + 2 * DAY_MS), t("c"));
    const fired = await clock.advanceWeeks(1);
    expect(fired).toBe(3);
    expect(log).toEqual([
      "a@2026-11-03T00:00:00.000Z",
      "b@2026-11-04T00:00:00.000Z",
      "c@2026-11-04T00:00:00.000Z",
    ]);
    expect(clock.now().getTime()).toBe(Date.parse(START) + WEEK_MS);
  });

  it("does not fire timers beyond the target and keeps them pending", async () => {
    const clock = new SimClock(START);
    let n = 0;
    clock.schedule(new Date(Date.parse(START) + 2 * WEEK_MS), () => void n++);
    await clock.advanceWeeks(1);
    expect(n).toBe(0);
    expect(clock.pending()).toBe(1);
    await clock.advanceWeeks(1);
    expect(n).toBe(1);
    expect(clock.pending()).toBe(0);
  });

  it("fires a timer scheduled exactly at the target instant", async () => {
    const clock = new SimClock(START);
    let n = 0;
    clock.schedule(new Date(Date.parse(START) + DAY_MS), () => void n++);
    await clock.advanceDays(1);
    expect(n).toBe(1);
  });

  it("fires timers that callbacks schedule inside the window", async () => {
    const clock = new SimClock(START);
    const log: string[] = [];
    clock.scheduleIn(DAY_MS, () => {
      log.push("first");
      clock.scheduleIn(DAY_MS, () => void log.push("second"));
    });
    await clock.advanceDays(3);
    expect(log).toEqual(["first", "second"]);
  });

  it("awaits async callbacks before the next timer", async () => {
    const clock = new SimClock(START);
    const log: string[] = [];
    clock.scheduleIn(1000, async () => {
      await new Promise((r) => setTimeout(r, 5));
      log.push("slow");
    });
    clock.scheduleIn(2000, () => void log.push("fast"));
    await clock.advanceBy(5000);
    expect(log).toEqual(["slow", "fast"]);
  });

  it("repeats an interval job deterministically across weeks", async () => {
    const clock = new SimClock(START);
    const days: string[] = [];
    clock.scheduleEvery(DAY_MS, () => void days.push(clock.now().toISOString().slice(0, 10)));
    await clock.advanceWeeks(1);
    expect(days).toHaveLength(7);
    expect(days[0]).toBe("2026-11-03");
    expect(days[6]).toBe("2026-11-09");
  });

  it("cancel removes a timer and a repeating job", async () => {
    const clock = new SimClock(START);
    let n = 0;
    const once = clock.scheduleIn(DAY_MS, () => void n++);
    const rep = clock.scheduleEvery(DAY_MS, () => void n++);
    clock.cancel(once);
    await clock.advanceDays(2);
    expect(n).toBe(2);
    clock.cancel(rep);
    await clock.advanceDays(2);
    expect(n).toBe(2);
  });

  it("a due-in-the-past timer fires on the next advance without moving time back", async () => {
    const clock = new SimClock(START);
    let at = "";
    clock.schedule(new Date("2026-10-01T00:00:00.000Z"), () => void (at = clock.now().toISOString()));
    await clock.advanceBy(1);
    expect(at).toBe("2026-11-02T00:00:00.000Z");
  });

  it("rejects non-positive intervals", () => {
    const clock = new SimClock(START);
    expect(() => clock.scheduleEvery(0, () => {})).toThrow();
  });

  it("is deterministic: two runs produce identical logs", async () => {
    const run = async () => {
      const clock = new SimClock(START);
      const log: string[] = [];
      clock.scheduleEvery(6 * 60 * 60_000, () => void log.push(clock.now().toISOString()));
      clock.scheduleIn(WEEK_MS, () => void log.push("review"));
      await clock.advanceCycles(1);
      return log;
    };
    expect(await run()).toEqual(await run());
  });
});
