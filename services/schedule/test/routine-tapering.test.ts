import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { AskPayloadSchema, type EventEnvelope } from "@my-wife/contracts";
import { createApp } from "../src/index";
import en from "../src/locales/en.json";
import vi from "../src/locales/vi.json";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const H = { "x-user-id": "u1" };
// Default zone UTC+7: 2026-11-27T03:00Z is 10:00 local on 2026-11-27.
const NOW = new Date("2026-11-27T03:00:00.000Z");

const dayBefore = (n: number) =>
  new Date(Date.UTC(2026, 10, 27) - n * 86_400_000).toISOString().slice(0, 10);

async function setup(settings: Record<string, unknown> = {}) {
  const events: EventEnvelope[] = [];
  const app = await createApp(config, {
    publish: (e: EventEnvelope) => void events.push(e),
    readSettings: async () => settings,
    now: () => NOW,
  });
  await app.inject({
    method: "POST",
    url: "/weeks",
    headers: H,
    payload: { firstDay: "2026-11-23" },
  });
  const record = (routineId: string, date: string, regular: boolean) =>
    app.inject({
      method: "POST",
      url: "/routines/habit-days",
      headers: H,
      payload: { routineId, date, regular },
    });
  /** Marks the `n` days before today as regular. */
  const streak = async (routineId: string, n: number) => {
    for (let i = 1; i <= n; i++) await record(routineId, dayBefore(i), true);
  };
  const proposals = () => events.filter((e) => e.type === "ask.routine_checkin");
  return { app, events, record, streak, proposals };
}

describe("routine tapering", () => {
  it("proposes a lower level after a stable streak (default 14 days)", async () => {
    const { app, events, streak, proposals } = await setup();
    await streak("lunch", 14);
    await app.runTaperingReview(NOW);
    const p = proposals();
    expect(p).toHaveLength(1);
    const payload = AskPayloadSchema.parse(p[0]!.payload);
    expect(payload).toMatchObject({
      kind: "routine_taper",
      subjectRef: "routine:lunch",
      params: { routineId: "lunch", from: "track", to: "remind", streakDays: 14 },
    });
    expect(payload.options.map((o) => o.value)).toEqual(["accept", "keep"]);
    // Only a proposal: nothing is applied, no fault, no level change.
    expect(events.some((e) => e.type === "routine.level_changed")).toBe(false);
    expect(events.some((e) => e.type === "routine.late_detected")).toBe(false);
    const levels = await app.inject({ method: "GET", url: "/routines", headers: H });
    const lunch = levels.json().data.routines.find((r: { id: string }) => r.id === "lunch");
    expect(lunch.level).toBe("track");
  });

  it("does not propose below the threshold", async () => {
    const { app, streak, proposals } = await setup();
    await streak("lunch", 13);
    await app.runTaperingReview(NOW);
    expect(proposals()).toHaveLength(0);
  });

  it("reads the threshold from routine.habit_stable_days", async () => {
    const { app, streak, proposals } = await setup({ "routine.habit_stable_days": 5 });
    await streak("lunch", 5);
    await app.runTaperingReview(NOW);
    expect(proposals()).toHaveLength(1);
  });

  it("restarts the streak after an irregular day", async () => {
    const { app, record, streak, proposals } = await setup({ "routine.habit_stable_days": 5 });
    await streak("lunch", 5);
    await record("lunch", dayBefore(2), false);
    await app.runTaperingReview(NOW);
    expect(proposals()).toHaveLength(0);
  });

  it("counts only consecutive days; a missing day breaks the streak", async () => {
    const { app, record, proposals } = await setup({ "routine.habit_stable_days": 3 });
    await record("lunch", dayBefore(1), true);
    await record("lunch", dayBefore(2), true);
    await record("lunch", dayBefore(4), true);
    await app.runTaperingReview(NOW);
    expect(proposals()).toHaveLength(0);
  });

  it("proposes once per streak, however often the review runs", async () => {
    const { app, streak, proposals } = await setup({ "routine.habit_stable_days": 3 });
    await streak("lunch", 3);
    await app.runTaperingReview(NOW);
    await app.runTaperingReview(NOW);
    expect(proposals()).toHaveLength(1);
  });

  it("proposes nothing for an `off` routine and steps `remind` down to `off`", async () => {
    const { app, streak, proposals } = await setup({
      "routine.habit_stable_days": 3,
      "routine.dinner.level": "off",
      "routine.lunch.level": "remind",
    });
    await streak("dinner", 3);
    await streak("lunch", 3);
    await app.runTaperingReview(NOW);
    expect(proposals().map((e) => (e.payload as { subjectRef: string }).subjectRef)).toEqual([
      "routine:lunch",
    ]);
    expect((proposals()[0]!.payload as { params: { to: string } }).params.to).toBe("off");
  });

  it("steps commit down to track; wake never goes below track", async () => {
    const { app, streak, proposals } = await setup({
      "routine.habit_stable_days": 3,
      "routine.wake.level": "track",
      "routine.sleep.level": "commit",
    });
    await streak("wake", 3);
    await streak("sleep", 3);
    await app.runTaperingReview(NOW);
    const by = Object.fromEntries(
      proposals().map((e) => {
        const p = e.payload as { subjectRef: string; params: { to: string } };
        return [p.subjectRef, p.params.to];
      }),
    );
    expect(by).toEqual({ "routine:sleep": "track" });
  });

  it("runs with the weekly review job", async () => {
    const { app, streak, proposals } = await setup({ "routine.habit_stable_days": 3 });
    await streak("lunch", 3);
    await app.inject({ method: "POST", url: "/jobs/week-boundary" });
    expect(proposals()).toHaveLength(1);
  });

  it("rejects an invalid habit day", async () => {
    const { record } = await setup();
    expect((await record("Bad Id", "2026-11-26", true)).statusCode).toBe(400);
    expect((await record("lunch", "nope", true)).statusCode).toBe(400);
  });

  it("has the proposal texts in both locales", () => {
    for (const key of [
      "routine.taper.option.accept",
      "routine.taper.option.keep",
      "routine.taper.question",
    ]) {
      expect((en as Record<string, string>)[key]).toBeTruthy();
      expect((vi as Record<string, string>)[key]).toBeTruthy();
    }
  });
});
