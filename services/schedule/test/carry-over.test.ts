import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import type { EventEnvelope } from "@my-wife/contracts";
import { createApp } from "../src/index";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const H = { "x-user-id": "u1" };

async function setup(settings: Record<string, unknown> = {}) {
  const events: EventEnvelope[] = [];
  let current = new Date("2026-11-23T10:00:00Z");
  const app = await createApp(config, {
    now: () => current,
    publish: (e) => void events.push(e),
    readSettings: async () => settings,
  });
  const create = async (day = "2026-11-23") => {
    const res = await app.inject({
      method: "POST",
      url: "/tasks",
      headers: H,
      payload: {
        title: "Write report",
        day,
        kind: "desk",
        estimatedMinutes: 30,
        monitoringProfile: "none",
      },
    });
    return res.json().data.task.id as string;
  };
  const task = async (taskId: string, day: string) => {
    const res = await app.inject({ method: "GET", url: `/checklist?date=${day}`, headers: H });
    return (res.json().data.tasks as Array<Record<string, unknown>>).find((t) => t.id === taskId);
  };
  const dayEnd = () => app.inject({ method: "POST", url: "/jobs/day-end" });
  const setNow = (iso: string) => void (current = new Date(iso));
  return { app, events, create, task, dayEnd, setNow };
}

describe("carry-over at day end", () => {
  it("roll_forward moves an unfinished task to the next day with carried_count 1", async () => {
    const { events, create, task, dayEnd, setNow } = await setup({
      "schedule.carry_over_rule": "roll_forward",
    });
    const id = await create();
    setNow("2026-11-24T00:05:00Z");
    await dayEnd();
    expect(await task(id, "2026-11-23")).toBeUndefined();
    expect(await task(id, "2026-11-24")).toMatchObject({ state: "planned", carriedCount: 1 });
    const carried = events.filter((e) => e.type === "task.carried");
    expect(carried).toHaveLength(1);
    expect(carried[0]?.payload).toEqual({ taskId: id, carriedCount: 1, toDay: "2026-11-24" });
  });

  it("uses roll_forward when the setting is absent and is idempotent", async () => {
    const { events, create, task, dayEnd, setNow } = await setup();
    const id = await create();
    setNow("2026-11-24T00:05:00Z");
    await dayEnd();
    await dayEnd();
    expect(await task(id, "2026-11-24")).toMatchObject({ carriedCount: 1 });
    expect(events.filter((e) => e.type === "task.carried")).toHaveLength(1);
  });

  it("does not touch done tasks or tasks of today", async () => {
    const { app, events, create, task, dayEnd, setNow } = await setup();
    const done = await create();
    await app.inject({
      method: "POST",
      url: "/tasks/complete",
      headers: H,
      payload: { taskId: done },
    });
    const today = await create("2026-11-24");
    setNow("2026-11-24T00:05:00Z");
    await dayEnd();
    expect(await task(done, "2026-11-23")).toMatchObject({ state: "done", carriedCount: 0 });
    expect(await task(today, "2026-11-24")).toMatchObject({ carriedCount: 0 });
    expect(events.some((e) => e.type === "task.carried")).toBe(false);
  });

  it("lower_priority moves the task and demotes it, stopping at low", async () => {
    const { create, task, dayEnd, setNow } = await setup({
      "schedule.carry_over_rule": "lower_priority",
    });
    const id = await create();
    setNow("2026-11-24T00:05:00Z");
    await dayEnd();
    expect(await task(id, "2026-11-24")).toMatchObject({ priority: "low", carriedCount: 1 });
    setNow("2026-11-25T00:05:00Z");
    await dayEnd();
    expect(await task(id, "2026-11-25")).toMatchObject({ priority: "low", carriedCount: 2 });
  });

  it("an in-progress task at day end is stopped and carried", async () => {
    const { app, create, task, dayEnd, setNow } = await setup();
    const id = await create();
    await app.inject({ method: "POST", url: "/tasks/start", headers: H, payload: { taskId: id } });
    setNow("2026-11-24T00:05:00Z");
    await dayEnd();
    expect(await task(id, "2026-11-24")).toMatchObject({ state: "planned", carriedCount: 1 });
  });

  it("asks through ask.carry_over when the rule is ask, once", async () => {
    const { events, create, task, dayEnd, setNow } = await setup({
      "schedule.carry_over_rule": "ask",
    });
    const id = await create();
    setNow("2026-11-24T00:05:00Z");
    await dayEnd();
    await dayEnd();
    const asks = events.filter((e) => e.type === "ask.carry_over");
    expect(asks).toHaveLength(1);
    expect(asks[0]?.payload).toMatchObject({
      kind: "carry_over",
      subjectRef: `task:${id}`,
      expiresAt: "2026-11-25T00:05:00.000Z",
    });
    expect(asks[0]?.userId).toBe("u1");
    expect(events.some((e) => e.type === "task.carried")).toBe(false);
    expect(await task(id, "2026-11-23")).toMatchObject({ carriedCount: 0 });
  });

  it("asks regardless of the rule once carry_over_max_times is reached", async () => {
    const { events, create, task, dayEnd, setNow } = await setup({
      "schedule.carry_over_rule": "roll_forward",
      "schedule.carry_over_max_times": 2,
    });
    const id = await create();
    setNow("2026-11-24T00:05:00Z");
    await dayEnd();
    setNow("2026-11-25T00:05:00Z");
    await dayEnd();
    expect(await task(id, "2026-11-25")).toMatchObject({ carriedCount: 2 });
    expect(events.some((e) => e.type === "ask.carry_over")).toBe(false);
    setNow("2026-11-26T00:05:00Z");
    await dayEnd();
    expect(events.filter((e) => e.type === "ask.carry_over")).toHaveLength(1);
    expect(await task(id, "2026-11-25")).toMatchObject({ carriedCount: 2 });
  });

  it("answers: roll_forward carries, skip skips, bad answers are rejected", async () => {
    const { app, events, create, task, dayEnd, setNow } = await setup({
      "schedule.carry_over_rule": "ask",
    });
    const a = await create();
    const b = await create();
    setNow("2026-11-24T00:05:00Z");
    await dayEnd();
    const questionOf = (id: string) =>
      (
        events.find(
          (e) =>
            e.type === "ask.carry_over" &&
            (e.payload as { subjectRef: string }).subjectRef === `task:${id}`,
        )?.payload as { questionId: string }
      ).questionId;
    const answer = (taskId: string, value: string, questionId = questionOf(taskId)) =>
      app.inject({
        method: "POST",
        url: "/tasks/carry-over-answer",
        headers: H,
        payload: { taskId, questionId, value },
      });
    expect((await answer(a, "nonsense")).statusCode).toBe(400);
    expect((await answer(a, "roll_forward", "other")).statusCode).toBe(409);
    expect((await answer(a, "roll_forward")).statusCode).toBe(200);
    expect(await task(a, "2026-11-24")).toMatchObject({ state: "planned", carriedCount: 1 });
    expect((await answer(a, "roll_forward")).statusCode).toBe(409);
    expect((await answer(b, "skip")).statusCode).toBe(200);
    expect(await task(b, "2026-11-23")).toMatchObject({ state: "skipped" });
  });

  it("an unanswered ask falls back to roll_forward after one day", async () => {
    const { create, task, dayEnd, setNow } = await setup({ "schedule.carry_over_rule": "ask" });
    const id = await create();
    setNow("2026-11-24T00:05:00Z");
    await dayEnd();
    setNow("2026-11-25T00:06:00Z");
    await dayEnd();
    expect(await task(id, "2026-11-25")).toMatchObject({ state: "planned", carriedCount: 1 });
  });
});
