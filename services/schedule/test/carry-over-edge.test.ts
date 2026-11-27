import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import type { EventEnvelope } from "@my-wife/contracts";
import { createApp } from "../src/index";
import { createMemoryPlanStore, type PlanTask } from "../src/plan";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const H = { "x-user-id": "u1" };

const baseTask = (over: Partial<PlanTask> = {}): PlanTask => ({
  id: "t1",
  userId: "u1",
  title: "Write report",
  day: "2026-11-23",
  window: null,
  estimatedMinutes: 30,
  energyLevel: null,
  definitionOfDone: null,
  monitoringProfile: "none",
  kind: "desk",
  state: "planned",
  carriedCount: 0,
  priority: "normal",
  pendingAsk: null,
  parentRecurrenceId: null,
  ...over,
});

async function withStore(
  settings: Record<string, unknown>,
  tasks: PlanTask[],
  publish: (e: EventEnvelope) => void | Promise<void>,
  nowIso = "2026-11-24T00:05:00Z",
  extra: { carryOverAskExpiryMs?: number } = {},
) {
  const planStore = createMemoryPlanStore();
  for (const t of tasks) planStore.addTask(t);
  let current = new Date(nowIso);
  const app = await createApp(config, {
    now: () => current,
    publish,
    readSettings: async () => settings,
    planStore,
    ...extra,
  });
  const dayEnd = () => app.inject({ method: "POST", url: "/jobs/day-end" });
  return { app, planStore, dayEnd, setNow: (iso: string) => void (current = new Date(iso)) };
}

const failing = () => {
  throw new Error("bus down");
};

describe("carry-over edge cases", () => {
  it("demotes high to normal, then normal to low", async () => {
    const { planStore, dayEnd, setNow } = await withStore(
      { "schedule.carry_over_rule": "lower_priority" },
      [baseTask({ priority: "high" })],
      () => undefined,
    );
    await dayEnd();
    expect(planStore.getTask("u1", "t1")?.priority).toBe("normal");
    setNow("2026-11-25T00:05:00Z");
    await dayEnd();
    expect(planStore.getTask("u1", "t1")?.priority).toBe("low");
  });

  it("rolls a failed carry publish back and retries on the next run", async () => {
    let fail = true;
    const { planStore, dayEnd } = await withStore({}, [baseTask({ state: "in_progress" })], () => {
      if (fail) failing();
    });
    const res = await dayEnd();
    expect(res.json().data.failed).toEqual(["t1"]);
    expect(planStore.getTask("u1", "t1")).toMatchObject({
      day: "2026-11-23",
      state: "in_progress",
      carriedCount: 0,
      priority: "normal",
    });
    fail = false;
    await dayEnd();
    expect(planStore.getTask("u1", "t1")).toMatchObject({ day: "2026-11-24", carriedCount: 1 });
  });

  it("a failed ask publish leaves the task and its state untouched", async () => {
    const { planStore, dayEnd } = await withStore(
      { "schedule.carry_over_rule": "ask" },
      [baseTask({ state: "in_progress" })],
      failing,
    );
    const res = await dayEnd();
    expect(res.json().data.failed).toEqual(["t1"]);
    expect(planStore.getTask("u1", "t1")).toMatchObject({
      state: "in_progress",
      pendingAsk: null,
      carriedCount: 0,
    });
  });

  it("decides the past day in the user's time zone", async () => {
    // 17:05 UTC on the 23rd is 00:05 on the 24th in UTC+7: the 23rd has ended there.
    const at = "2026-11-23T17:05:00Z";
    const plus7 = await withStore(
      { "calendar.time_zone": "Asia/Ho_Chi_Minh" },
      [baseTask()],
      () => undefined,
      at,
    );
    await plus7.dayEnd();
    expect(plus7.planStore.getTask("u1", "t1")).toMatchObject({
      day: "2026-11-24",
      carriedCount: 1,
    });
    const utc = await withStore({ "calendar.time_zone": "UTC" }, [baseTask()], () => undefined, at);
    await utc.dayEnd();
    expect(utc.planStore.getTask("u1", "t1")).toMatchObject({
      day: "2026-11-23",
      carriedCount: 0,
    });
  });

  it("accepts an answer after the question expired but before the job ran", async () => {
    const events: EventEnvelope[] = [];
    const { app, planStore, dayEnd, setNow } = await withStore(
      { "schedule.carry_over_rule": "ask" },
      [baseTask()],
      (e) => void events.push(e),
    );
    await dayEnd();
    const questionId = (events[0]?.payload as { questionId: string }).questionId;
    setNow("2026-11-25T06:00:00Z");
    const res = await app.inject({
      method: "POST",
      url: "/tasks/carry-over-answer",
      headers: H,
      payload: { taskId: "t1", questionId, value: "roll_forward" },
    });
    expect(res.statusCode).toBe(200);
    expect(planStore.getTask("u1", "t1")).toMatchObject({ day: "2026-11-25", carriedCount: 1 });
  });

  it("takes the question lifetime from the injected option", async () => {
    const events: EventEnvelope[] = [];
    const { dayEnd } = await withStore(
      { "schedule.carry_over_rule": "ask" },
      [baseTask()],
      (e) => void events.push(e),
      "2026-11-24T00:05:00Z",
      { carryOverAskExpiryMs: 3_600_000 },
    );
    await dayEnd();
    expect((events[0]?.payload as { expiresAt: string }).expiresAt).toBe(
      "2026-11-24T01:05:00.000Z",
    );
  });
});
