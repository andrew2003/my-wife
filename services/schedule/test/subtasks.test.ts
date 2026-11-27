import { describe, expect, it } from "vitest";
import { loadConfig } from "@my-wife/config";
import { createApp } from "../src/index";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), LOG_LEVEL: "silent" });
const H = { "x-user-id": "u1" };
const OTHER = { "x-user-id": "u2" };

async function setup() {
  const app = await createApp(config, { now: () => new Date("2026-11-23T08:00:00Z") });
  const res = await app.inject({
    method: "POST",
    url: "/tasks",
    headers: H,
    payload: {
      title: "Write report",
      day: "2026-11-23",
      kind: "desk",
      estimatedMinutes: 60,
      monitoringProfile: "none",
    },
  });
  const taskId = res.json().data.task.id as string;
  const add = async (title: string, headers = H) =>
    app.inject({ method: "POST", url: "/tasks/subtasks", headers, payload: { taskId, title } });
  const mark = (subtaskId: string, done: boolean) =>
    app.inject({ method: "POST", url: "/subtasks/done", headers: H, payload: { subtaskId, done } });
  const complete = () =>
    app.inject({ method: "POST", url: "/tasks/complete", headers: H, payload: { taskId } });
  return { app, taskId, add, mark, complete };
}

describe("sub-tasks", () => {
  it("adds and lists sub-tasks of the caller's task only", async () => {
    const { app, taskId, add } = await setup();
    const res = await add("Outline");
    expect(res.statusCode).toBe(200);
    expect(res.json().data.subtask).toMatchObject({ taskId, title: "Outline", done: false });
    expect((await add("Nope", OTHER)).statusCode).toBe(404);
    const list = await app.inject({
      method: "GET",
      url: `/tasks/subtasks?taskId=${taskId}`,
      headers: H,
    });
    expect(list.json().data.subtasks).toHaveLength(1);
  });

  it("rejects an empty title", async () => {
    const { add } = await setup();
    expect((await add("")).statusCode).toBe(400);
  });

  it("blocks completing the parent while a sub-task is open", async () => {
    const { add, complete } = await setup();
    await add("Outline");
    const res = await complete();
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("schedule.task_subtasks_open");
  });

  it("completes the parent once all sub-tasks are done", async () => {
    const { add, mark, complete } = await setup();
    const a = (await add("A")).json().data.subtask.id;
    const b = (await add("B")).json().data.subtask.id;
    expect((await mark(a, true)).statusCode).toBe(200);
    expect((await complete()).statusCode).toBe(409);
    await mark(b, true);
    const res = await complete();
    expect(res.statusCode).toBe(200);
    expect(res.json().data.task.state).toBe("done");
  });

  it("a reopened sub-task blocks the parent again", async () => {
    const { add, mark, complete } = await setup();
    const a = (await add("A")).json().data.subtask.id;
    await mark(a, true);
    await mark(a, false);
    expect((await complete()).statusCode).toBe(409);
  });
});
